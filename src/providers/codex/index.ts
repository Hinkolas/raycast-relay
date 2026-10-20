import { mkdir } from "node:fs/promises";
import {
  ProviderError,
  type ModelInfo,
  type Provider,
  type SendRequest,
  type SendResult,
  type UsageLimit,
} from "../types";
import { locateBinary } from "../locate";
import { formatTranscript } from "../transcript";
import { TurnActivity } from "./activity";
import { AppServerConnection } from "./app-server";
import type {
  GetAccountResponse,
  Model,
  ModelListResponse,
  RateLimitSnapshot,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
} from "./protocol";

export interface CodexProviderOptions {
  /** Custom path to the codex binary; detected automatically when empty. */
  binaryPath?: string;
  /** Working directory for threads. Chats run read-only, so this is mostly irrelevant, but should be empty. */
  workingDirectory: string;
  clientVersion: string;
}

interface LiveThread {
  threadId: string;
  connection: AppServerConnection;
  model: string | undefined;
  /** Number of history turns the thread has seen, to detect when our history and Codex' diverge. */
  turns: number;
}

/**
 * Talks to the Codex CLI through `codex app-server`, the same JSON-RPC interface the Codex IDE extension and
 * T3 Code use. Threads are ephemeral so quick questions don't clutter the user's Codex history; the extension
 * keeps its own transcript and replays it when a conversation is resumed in a new process.
 */
export class CodexProvider implements Provider {
  readonly id = "codex";
  readonly name = "Codex";

  private connection: Promise<AppServerConnection> | undefined;
  private readonly threads = new Map<string, LiveThread>();
  /** Raw model list, needed to map "fast" onto each model's service tier. */
  private models: Model[] = [];
  private limits: UsageLimit[] | undefined;

  constructor(private readonly options: CodexProviderOptions) {}

  warmUp() {
    this.connect().catch(() => undefined);
  }

  async listModels(): Promise<ModelInfo[]> {
    const connection = await this.connect();
    const { data } = await connection.request<ModelListResponse>("model/list", {});
    this.models = data;
    return data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.model,
        name: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        reasoningEfforts: model.supportedReasoningEfforts.map((option) => ({
          id: option.reasoningEffort,
          description: option.description,
        })),
        defaultReasoningEffort: model.defaultReasoningEffort,
        fastMode: model.serviceTiers?.[0] ? { description: model.serviceTiers[0].description } : undefined,
      }));
  }

  async send(request: SendRequest): Promise<SendResult> {
    const connection = await this.connect();
    const threadId = await this.ensureThread(connection, request);
    if (request.signal?.aborted) return { text: "", steps: [], interrupted: true };

    try {
      const result = await this.runTurn(connection, threadId, request);
      const live = this.threads.get(request.conversationId);
      if (result.interrupted) {
        // Codex keeps the partial turn, our transcript may not. Start fresh from our history next time.
        this.threads.delete(request.conversationId);
      } else if (live) {
        live.turns += 1;
      }
      return result;
    } catch (error) {
      this.threads.delete(request.conversationId);
      throw error;
    }
  }

  private connect(): Promise<AppServerConnection> {
    if (!this.connection) {
      const connection = this.open();
      this.connection = connection;
      connection.then(
        (live) =>
          live.onExit(() => {
            if (this.connection === connection) this.connection = undefined;
          }),
        () => {
          if (this.connection === connection) this.connection = undefined;
        },
      );
    }
    return this.connection;
  }

  private async open(): Promise<AppServerConnection> {
    const { binary, env } = await locateBinary({
      command: "codex",
      label: "Codex CLI",
      customPath: this.options.binaryPath,
      preferenceTitle: "Codex CLI Path",
      installHint:
        "Install it with `npm install -g @openai/codex` or `brew install codex`, then sign in with `codex login`.",
    });
    await mkdir(this.options.workingDirectory, { recursive: true });

    let connection: AppServerConnection;
    try {
      connection = await AppServerConnection.connect({
        binary,
        env,
        cwd: this.options.workingDirectory,
        clientInfo: { name: "raycast_relay", title: "Raycast Relay", version: this.options.clientVersion },
      });
    } catch (error) {
      throw new ProviderError(
        "Couldn't start Codex",
        `${errorMessage(error)}. Make sure \`${binary} app-server\` works in your terminal; updating with \`codex update\` may help.`,
      );
    }

    connection.onNotification((notification) => {
      if (notification.method === "account/rateLimits/updated") {
        this.limits = toUsageLimits(notification.params.rateLimits) ?? this.limits;
      }
    });

    const { account, requiresOpenaiAuth } = await connection.request<GetAccountResponse>("account/read", {});
    if (requiresOpenaiAuth && !account) {
      connection.close();
      throw new ProviderError("Codex isn't signed in", "Run `codex login` in your terminal, then try again.");
    }
    connection.request<{ rateLimits: RateLimitSnapshot }>("account/rateLimits/read", {}).then(
      ({ rateLimits }) => (this.limits ??= toUsageLimits(rateLimits)),
      () => undefined, // Not available for API-key sign-ins.
    );
    return connection;
  }

  private async ensureThread(connection: AppServerConnection, request: SendRequest): Promise<string> {
    const live = this.threads.get(request.conversationId);
    if (
      live &&
      live.connection === connection &&
      live.model === request.model &&
      live.turns === request.history.length
    ) {
      return live.threadId;
    }

    const params: ThreadStartParams = {
      ephemeral: true,
      cwd: this.options.workingDirectory,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: request.model ?? null,
      baseInstructions: request.instructions,
      developerInstructions: request.history.length > 0 ? formatTranscript(request.history) : null,
      config: { web_search: request.webSearch ? "live" : "disabled" },
    };
    const { thread } = await connection.request<ThreadStartResponse>("thread/start", params);
    this.threads.set(request.conversationId, {
      threadId: thread.id,
      connection,
      model: request.model,
      turns: request.history.length,
    });
    return thread.id;
  }

  private runTurn(connection: AppServerConnection, threadId: string, request: SendRequest): Promise<SendResult> {
    return new Promise<SendResult>((resolve, reject) => {
      const activity = new TurnActivity();
      let turnId: string | undefined;
      let interruptRequested = false;
      let lastError: string | undefined;
      let settled = false;

      const emit = () => request.onUpdate?.({ text: activity.text, steps: activity.stepList });
      const interrupt = () => {
        if (turnId) connection.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      };
      const onAbort = () => {
        interruptRequested = true;
        interrupt();
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        stopListening();
        stopWatchingExit();
        request.signal?.removeEventListener("abort", onAbort);
        finish();
      };
      const setTurnId = (id: string) => {
        if (turnId) return;
        turnId = id;
        if (interruptRequested) interrupt();
      };

      const stopListening = connection.onNotification((notification) => {
        if (notification.params.threadId !== threadId) return;

        switch (notification.method) {
          case "turn/started":
            setTurnId(notification.params.turn.id);
            break;
          case "error":
            if (!notification.params.willRetry) lastError = notification.params.error.message;
            break;
          case "turn/completed": {
            const { turn } = notification.params;
            activity.finish(turn.status === "failed" ? "failed" : "done");
            if (turn.status === "failed") {
              const message = turn.error?.message ?? lastError ?? "Codex couldn't finish the answer";
              settle(() => reject(new ProviderError(message, turn.error?.additionalDetails ?? undefined)));
            } else {
              settle(() =>
                resolve({
                  text: activity.text,
                  steps: activity.stepList,
                  usage: activity.tokenUsage,
                  limits: this.limits,
                  interrupted: turn.status === "interrupted",
                }),
              );
            }
            break;
          }
          default:
            if (activity.apply(notification)) emit();
        }
      });
      const stopWatchingExit = connection.onExit((error) => settle(() => reject(error)));
      request.signal?.addEventListener("abort", onAbort, { once: true });

      const params: TurnStartParams = {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        model: request.model ?? null,
        effort: request.reasoningEffort ?? null,
        summary: "auto",
        serviceTierForTurn: this.serviceTier(request),
      };
      connection.request<TurnStartResponse>("turn/start", params).then(
        ({ turn }) => setTurnId(turn.id),
        (error) => settle(() => reject(error)),
      );
    });
  }

  /** "Fast" maps onto the model's first non-default service tier (currently "priority"). */
  private serviceTier(request: SendRequest): string {
    if (!request.fast) return "default";
    const model = this.models.find((candidate) =>
      request.model ? candidate.model === request.model : candidate.isDefault,
    );
    return model?.serviceTiers?.[0]?.id ?? "default";
  }
}

function toUsageLimits(snapshot: RateLimitSnapshot): UsageLimit[] | undefined {
  const windows = [snapshot.primary, snapshot.secondary].filter((window) => window !== null);
  if (windows.length === 0) return undefined;
  return windows.map((window) => ({
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins ?? undefined,
    resetsAt: window.resetsAt ?? undefined,
  }));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
}
