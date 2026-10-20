import { mkdir } from "node:fs/promises";
import { locateBinary } from "../locate";
import { formatTranscript } from "../transcript";
import { ProviderError, type ModelInfo, type Provider, type SendRequest, type SendResult } from "../types";
import { TurnActivity } from "./activity";
import { OpenCodeClient } from "./client";
import {
  eventSessionId,
  type Form,
  type Location,
  type Model,
  type ModelRef,
  type PermissionRule,
  type ProviderInfo,
  type Session,
  type StructuredError,
} from "./protocol";

export interface OpenCodeProviderOptions {
  /** Custom path to the opencode binary; detected automatically when empty. */
  binaryPath?: string;
  /** Working directory for sessions. Chats can't touch files, so this only has to be a folder of our own. */
  workingDirectory: string;
}

interface LiveSession {
  sessionId: string;
  client: OpenCodeClient;
  model: ModelRef;
  /** Number of history turns the session has seen, to detect when our history and OpenCode's diverge. */
  turns: number;
}

/** Sessions Relay left behind are deleted once they've been idle for this long. */
const STALE_SESSION_MS = 15 * 60 * 1000;

/**
 * Talks to OpenCode through its background service (`opencode service start`), so every provider, model,
 * credential and web search integration the user set up in OpenCode works here too.
 *
 * Sessions live in a folder of Relay's own and may only search the web and read pages. Like Codex threads they're
 * temporary: the extension keeps its own transcript, and sessions are deleted when they're replaced or go stale.
 */
export class OpenCodeProvider implements Provider {
  readonly id = "opencode";
  readonly name = "OpenCode";

  private connection: Promise<OpenCodeClient> | undefined;
  private readonly sessions = new Map<string, LiveSession>();
  private defaultModel: ModelRef | undefined;

  constructor(private readonly options: OpenCodeProviderOptions) {}

  private get location(): Location {
    return { directory: this.options.workingDirectory };
  }

  private get locationQuery() {
    return { "location[directory]": this.options.workingDirectory };
  }

  warmUp() {
    this.connect().catch(() => undefined);
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = await this.connect();
    const [models, providers, defaultModel] = await Promise.all([
      client.request<{ data: Model[] }>("GET", "/api/model", { query: this.locationQuery }),
      client.request<{ data: ProviderInfo[] }>("GET", "/api/provider", { query: this.locationQuery }),
      this.resolveDefaultModel(client).catch(() => undefined),
    ]);
    const providerNames = new Map(providers.data.map((provider) => [provider.id, provider.name]));
    return models.data
      .filter((model) => model.enabled && model.status !== "deprecated")
      .map((model) => ({
        id: modelId(model),
        name: model.name,
        group: providerNames.get(model.providerID) ?? titleCase(model.providerID),
        isDefault: defaultModel ? modelId(defaultModel) === modelId(model) : false,
        reasoningEfforts: model.variants
          .filter((variant) => variant.id !== "default")
          .map((variant) => ({ id: variant.id })),
      }));
  }

  async send(request: SendRequest): Promise<SendResult> {
    const client = await this.connect();
    const sessionId = await this.ensureSession(client, request);
    if (request.signal?.aborted) return { text: "", steps: [], interrupted: true };

    try {
      const result = await this.runTurn(client, sessionId, request);
      if (result.interrupted) {
        // OpenCode keeps the partial turn, our transcript may not. Start fresh from our history next time.
        this.dropSession(request.conversationId);
      } else {
        const live = this.sessions.get(request.conversationId);
        if (live) live.turns += 1;
      }
      return result;
    } catch (error) {
      this.dropSession(request.conversationId);
      throw error;
    }
  }

  private connect(): Promise<OpenCodeClient> {
    if (!this.connection) {
      const connection = this.open();
      this.connection = connection;
      connection.then(
        (client) =>
          client.onClose(() => {
            if (this.connection === connection) this.connection = undefined;
          }),
        () => {
          if (this.connection === connection) this.connection = undefined;
        },
      );
    }
    return this.connection;
  }

  private async open(): Promise<OpenCodeClient> {
    const { binary, env } = await locateBinary({
      command: "opencode",
      label: "OpenCode",
      customPath: this.options.binaryPath,
      preferenceTitle: "OpenCode Path",
      installHint: "Install it from https://opencode.ai and connect a model provider with `opencode auth login`.",
    });
    await mkdir(this.options.workingDirectory, { recursive: true });

    let client: OpenCodeClient;
    try {
      client = await OpenCodeClient.connect({ binary, env });
    } catch (error) {
      throw new ProviderError(
        "Couldn't connect to OpenCode",
        `${errorMessage(error)}. Make sure \`${binary} service start\` works in your terminal; updating with \`opencode upgrade\` may help.`,
      );
    }
    void this.deleteStaleSessions(client);
    return client;
  }

  private async resolveDefaultModel(client: OpenCodeClient): Promise<ModelRef> {
    if (this.defaultModel) return this.defaultModel;
    const { data } = await client.request<{ data: Model | null }>("GET", "/api/model/default", {
      query: this.locationQuery,
    });
    if (!data) {
      throw new ProviderError(
        "OpenCode has no model to use",
        "Connect a provider in OpenCode first, e.g. with `opencode auth login`, then try again.",
      );
    }
    this.defaultModel = { id: data.id, providerID: data.providerID };
    return this.defaultModel;
  }

  /** The model and variant for a request. Always explicit, so a live session can be switched back to the default. */
  private async modelFor(client: OpenCodeClient, request: SendRequest): Promise<ModelRef> {
    const base = request.model ? parseModelId(request.model) : await this.resolveDefaultModel(client);
    return request.reasoningEffort ? { ...base, variant: request.reasoningEffort } : base;
  }

  private async ensureSession(client: OpenCodeClient, request: SendRequest): Promise<string> {
    const model = await this.modelFor(client, request);
    const live = this.sessions.get(request.conversationId);
    if (live && live.client === client && live.turns === request.history.length) {
      if (!sameModel(live.model, model)) {
        await client.request("POST", `/api/session/${live.sessionId}/model`, { body: { model } });
        live.model = model;
      }
      return live.sessionId;
    }
    this.dropSession(request.conversationId);

    const { data: session } = await client.request<{ data: Session }>("POST", "/api/session", {
      body: {
        title: `Relay: ${sessionTitle(request.history[0]?.prompt ?? request.prompt)}`,
        location: this.location,
        model,
        permissions: permissionsFor(request.webSearch),
        metadata: { client: "raycast-relay" },
      },
    });
    this.sessions.set(request.conversationId, { sessionId: session.id, client, model, turns: request.history.length });

    const instructions =
      request.history.length > 0
        ? `${request.instructions}\n\n${formatTranscript(request.history)}`
        : request.instructions;
    await client.request("PUT", `/api/experimental/session/${session.id}/instructions/entries/relay`, {
      body: { value: instructions },
    });
    return session.id;
  }

  private runTurn(client: OpenCodeClient, sessionId: string, request: SendRequest): Promise<SendResult> {
    return new Promise<SendResult>((resolve, reject) => {
      const activity = new TurnActivity();
      let lastError: StructuredError | undefined;
      let settled = false;

      const emit = () => request.onUpdate?.({ text: activity.text, steps: activity.stepList });
      const onAbort = () => {
        client.request("POST", `/api/session/${sessionId}/interrupt`).catch(() => undefined);
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        stopListening();
        stopWatchingClose();
        request.signal?.removeEventListener("abort", onAbort);
        finish();
      };
      const result = (interrupted: boolean): SendResult => ({
        text: activity.text,
        steps: activity.stepList,
        usage: activity.tokenUsage,
        interrupted,
      });

      const stopListening = client.onEvent((event) => {
        if (eventSessionId(event) !== sessionId) return;

        switch (event.type) {
          case "form.created":
            this.answerForm(client, event.data.form, request.webSearch);
            break;
          case "permission.asked":
            // Sessions only allow web access; anything else the agent asks for is declined.
            client
              .request("POST", `/api/session/${sessionId}/permission/${event.data.id}/reply`, {
                body: { decision: "reject" },
              })
              .catch(() => undefined);
            break;
          case "session.error":
            lastError = event.data.error ?? lastError;
            break;
          case "session.execution.succeeded":
            activity.finish("done");
            settle(() => resolve(result(false)));
            break;
          case "session.execution.interrupted":
            activity.finish("failed");
            settle(() => resolve(result(true)));
            break;
          case "session.execution.failed": {
            activity.finish("failed");
            const error = event.data.error ?? lastError;
            settle(() =>
              reject(new ProviderError(error?.message || "OpenCode couldn't finish the answer", errorHint(error))),
            );
            break;
          }
          default:
            if (activity.apply(event)) emit();
        }
      });
      const stopWatchingClose = client.onClose((error) => settle(() => reject(error)));
      request.signal?.addEventListener("abort", onAbort, { once: true });

      client
        .request("POST", `/api/session/${sessionId}/prompt`, { body: { text: request.prompt } })
        .catch((error) => settle(() => reject(error)));
    });
  }

  /**
   * OpenCode asks for consent the first time the agent searches the web. With web search turned on in Relay, that
   * consent was given already; other questions can't be answered from Raycast and are cancelled.
   */
  private answerForm(client: OpenCodeClient, form: Form, webSearch: boolean) {
    const path = `/api/session/${form.sessionID}/form/${form.id}`;
    const allow = form.fields[0]?.options?.find((option) => option.value === "allow");
    if (webSearch && form.metadata?.kind === "websearch.provider" && allow) {
      client.request("POST", `${path}/reply`, { body: { answer: { [form.fields[0].key]: allow.value } } }).catch(() => {
        client.request("DELETE", path).catch(() => undefined);
      });
    } else {
      client.request("DELETE", path).catch(() => undefined);
    }
  }

  private dropSession(conversationId: string) {
    const live = this.sessions.get(conversationId);
    if (!live) return;
    this.sessions.delete(conversationId);
    live.client.request("DELETE", `/api/session/${live.sessionId}`).catch(() => undefined);
  }

  /** Relay's folder only holds Relay's sessions; remove the ones earlier runs of the extension left behind. */
  private async deleteStaleSessions(client: OpenCodeClient) {
    try {
      const { data } = await client.request<{ data: Session[] }>("GET", "/api/session", {
        query: { directory: this.options.workingDirectory, limit: "100" },
      });
      const live = new Set([...this.sessions.values()].map((session) => session.sessionId));
      const cutoff = Date.now() - STALE_SESSION_MS;
      for (const session of data) {
        // Never touch sessions outside Relay's folder, even if the server ignored the filter.
        if (session.location?.directory !== this.options.workingDirectory) continue;
        if (live.has(session.id) || session.time.updated > cutoff) continue;
        await client.request("DELETE", `/api/session/${session.id}`).catch(() => undefined);
      }
    } catch {
      // Best effort.
    }
  }
}

/** Relay's ids join provider and model, e.g. "ollama-cloud/glm-5.3". Model ids may contain slashes themselves. */
function modelId(model: { id: string; providerID: string }): string {
  return `${model.providerID}/${model.id}`;
}

function parseModelId(id: string): ModelRef {
  const slash = id.indexOf("/");
  if (slash === -1) throw new ProviderError(`Unknown OpenCode model "${id}"`, "Pick another model with ⌘⇧M.");
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1) };
}

/** "ollama-cloud" → "Ollama Cloud", for providers the server didn't name. */
function titleCase(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.id === b.id && a.variant === b.variant;
}

/** Deny everything but web access. Later rules win, so the specific allows follow the catch-all. */
function permissionsFor(webSearch: boolean): PermissionRule[] {
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];
  if (webSearch) {
    rules.push({ action: "websearch", resource: "*", effect: "allow" });
    rules.push({ action: "webfetch", resource: "*", effect: "allow" });
  }
  return rules;
}

function sessionTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function errorHint(error: StructuredError | undefined): string | undefined {
  if (error?.status === 401 || error?.status === 403) {
    return "The model provider rejected OpenCode's credentials. Sign in again with `opencode auth login`.";
  }
  if (error?.status === 429) return "The model provider's rate limit was hit. Wait a moment or pick another model.";
  return undefined;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
}
