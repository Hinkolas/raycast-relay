import { mkdir } from "node:fs/promises";
import {
  ProviderError,
  type HistoryTurn,
  type ModelInfo,
  type Provider,
  type SendRequest,
  type SendResult,
} from "../types";
import { AppServerConnection } from "./app-server";
import { locateCodex } from "./locate";
import type {
  GetAccountResponse,
  ModelListResponse,
  ThreadItem,
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

  constructor(private readonly options: CodexProviderOptions) {}

  warmUp() {
    this.connect().catch(() => undefined);
  }

  async listModels(): Promise<ModelInfo[]> {
    const connection = await this.connect();
    const { data } = await connection.request<ModelListResponse>("model/list", {});
    return data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.model,
        name: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
      }));
  }

  async send(request: SendRequest): Promise<SendResult> {
    const connection = await this.connect();
    const threadId = await this.ensureThread(connection, request);
    if (request.signal?.aborted) return { text: "", interrupted: true };

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
    const { binary, env } = await locateCodex(this.options.binaryPath);
    await mkdir(this.options.workingDirectory, { recursive: true });

    let connection: AppServerConnection;
    try {
      connection = await AppServerConnection.connect({
        binary,
        env,
        cwd: this.options.workingDirectory,
        clientInfo: { name: "raycast_agent_proxy", title: "Raycast Agent Proxy", version: this.options.clientVersion },
      });
    } catch (error) {
      throw new ProviderError(
        "Couldn't start Codex",
        `${errorMessage(error)}. Make sure \`${binary} app-server\` works in your terminal; updating with \`codex update\` may help.`,
      );
    }

    const { account, requiresOpenaiAuth } = await connection.request<GetAccountResponse>("account/read", {});
    if (requiresOpenaiAuth && !account) {
      connection.close();
      throw new ProviderError("Codex isn't signed in", "Run `codex login` in your terminal, then try again.");
    }
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
      // Agent messages by item id, in the order they started. A turn can contain several (e.g. before and
      // after a web search); together they form the answer.
      const messages = new Map<string, string>();
      let turnId: string | undefined;
      let activity: string | undefined;
      let interruptRequested = false;
      let lastError: string | undefined;
      let settled = false;

      const answer = () =>
        [...messages.values()]
          .map((text) => text.trim())
          .filter(Boolean)
          .join("\n\n");
      const emit = () => request.onUpdate?.({ text: answer(), activity });

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
          case "item/started": {
            const { item } = notification.params;
            if (item.type === "agentMessage") {
              messages.set(item.id, messages.get(item.id) ?? "");
            } else {
              activity = describeActivity(item) ?? activity;
              emit();
            }
            break;
          }
          case "item/agentMessage/delta": {
            const { itemId, delta } = notification.params;
            messages.set(itemId, (messages.get(itemId) ?? "") + delta);
            activity = undefined;
            emit();
            break;
          }
          case "item/completed": {
            const { item } = notification.params;
            if (item.type === "agentMessage" && "text" in item) messages.set(item.id, item.text);
            activity = undefined;
            emit();
            break;
          }
          case "error":
            if (notification.params.willRetry) {
              activity = "Reconnecting…";
              emit();
            } else {
              lastError = notification.params.error.message;
            }
            break;
          case "turn/completed": {
            const { turn } = notification.params;
            if (turn.status === "failed") {
              const message = turn.error?.message ?? lastError ?? "Codex couldn't finish the answer";
              settle(() => reject(new ProviderError(message, turn.error?.additionalDetails ?? undefined)));
            } else {
              settle(() => resolve({ text: answer(), interrupted: turn.status === "interrupted" }));
            }
            break;
          }
        }
      });
      const stopWatchingExit = connection.onExit((error) => settle(() => reject(error)));
      request.signal?.addEventListener("abort", onAbort, { once: true });

      const params: TurnStartParams = {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        model: request.model ?? null,
        effort: request.reasoningEffort ?? null,
      };
      connection.request<TurnStartResponse>("turn/start", params).then(
        ({ turn }) => setTurnId(turn.id),
        (error) => settle(() => reject(error)),
      );
    });
  }
}

function describeActivity(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "reasoning":
      return "Thinking…";
    case "webSearch":
      return "Searching the web…";
    case "commandExecution":
      return "Running a command…";
    case "mcpToolCall":
      return "server" in item ? `Using ${item.server}…` : "Using a tool…";
    case "fileChange":
      return "Editing files…";
    default:
      return undefined;
  }
}

/** Seeds a fresh thread with a conversation that was started in an earlier session. */
function formatTranscript(history: HistoryTurn[]): string {
  const turns = history.map((turn) => `<user>\n${turn.prompt}\n</user>\n<assistant>\n${turn.answer}\n</assistant>`);
  return [
    "This conversation is being continued from an earlier session. Here is the transcript so far; continue it naturally and don't mention that it was restored.",
    `<transcript>\n${turns.join("\n")}\n</transcript>`,
  ].join("\n\n");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
}
