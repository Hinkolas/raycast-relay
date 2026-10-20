import { mkdir } from "node:fs/promises";
import { locateBinary, type Installation } from "../locate";
import { formatTranscript } from "../transcript";
import {
  ProviderError,
  type ModelInfo,
  type Provider,
  type SendRequest,
  type SendResult,
  type UsageLimit,
} from "../types";
import { TurnActivity } from "./activity";
import { ClaudeProcess } from "./process";
import type { AssistantError, CliModel, FlagSettings, RateLimitInfo } from "./protocol";

export interface ClaudeCodeProviderOptions {
  /** Custom path to the claude binary; detected automatically when empty. */
  binaryPath?: string;
  /** Working directory for sessions. Chats can't touch files, so this only has to be a folder of our own. */
  workingDirectory: string;
}

interface LiveSession {
  process: ClaudeProcess;
  /** Model, effort and fast mode as last applied to the process. */
  settings: FlagSettings;
  /** Number of history turns the session has seen, to detect when our history and Claude Code's diverge. */
  turns: number;
  busy: boolean;
  lastUsed: number;
}

/** Each conversation holds a process; the least recently used idle ones are closed beyond this many. */
const MAX_LIVE_SESSIONS = 4;

const DEFAULT_SETTINGS: FlagSettings = { model: null, effortLevel: null, fastMode: null };

/** Usage windows Claude reports, with their length in minutes. */
const LIMIT_WINDOWS: Record<string, number> = { five_hour: 300, seven_day: 10080 };

/**
 * Talks to Claude Code through `claude -p` in stream-json mode, the protocol the Claude Agent SDK uses. The CLI
 * brings the user's sign-in (Claude subscription, API key, Bedrock, Vertex, …), models and settings.
 *
 * Each conversation runs in a process of its own that may only search the web and read pages; MCP servers, hooks
 * and project settings stay out. Sessions aren't saved to disk: the extension keeps its own transcript and replays
 * it when a conversation is resumed in a new process.
 */
export class ClaudeCodeProvider implements Provider {
  readonly id = "claude";
  readonly name = "Claude Code";

  private installation: Promise<Installation> | undefined;
  private readonly sessions = new Map<string, LiveSession>();
  private limits: UsageLimit[] | undefined;

  constructor(private readonly options: ClaudeCodeProviderOptions) {}

  warmUp() {
    this.locate().catch(() => undefined);
  }

  async listModels(): Promise<ModelInfo[]> {
    const { process: claude, init } = await this.start({
      instructions: "You are a helpful assistant.",
      webSearch: false,
    });
    claude.close();
    return toModelInfos(init.models ?? []);
  }

  async send(request: SendRequest): Promise<SendResult> {
    const live = await this.ensureSession(request);
    if (request.signal?.aborted) return { text: "", steps: [], interrupted: true };

    live.busy = true;
    live.lastUsed = Date.now();
    try {
      await this.applySettings(live, request);
      const result = await this.runTurn(live.process, request);
      if (result.interrupted) {
        // Claude Code keeps the partial turn, our transcript may not. Start fresh from our history next time.
        this.dropSession(request.conversationId);
      } else {
        live.turns += 1;
      }
      return result;
    } catch (error) {
      this.dropSession(request.conversationId);
      throw error;
    } finally {
      live.busy = false;
    }
  }

  private locate(): Promise<Installation> {
    this.installation ??= locateBinary({
      command: "claude",
      label: "Claude Code",
      customPath: this.options.binaryPath,
      preferenceTitle: "Claude Code Path",
      installHint: "Install it from https://claude.com/claude-code, then sign in by running `claude`.",
    });
    this.installation.catch(() => (this.installation = undefined));
    return this.installation;
  }

  private async start({ instructions, webSearch }: { instructions: string; webSearch: boolean }) {
    const { binary, env } = await this.locate();
    await mkdir(this.options.workingDirectory, { recursive: true });

    const tools = webSearch ? "WebSearch,WebFetch" : "";
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      // The user's settings (sign-in, model, environment) apply; the workspace has no project settings anyway.
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--tools",
      tools,
      ...(webSearch ? ["--allowedTools", tools] : []),
      "--permission-prompts",
      "none",
      "--thinking-display",
      "summarized",
      "--system-prompt",
      instructions,
    ];

    try {
      return await ClaudeProcess.start({ binary, args, cwd: this.options.workingDirectory, env });
    } catch (error) {
      throw new ProviderError(
        "Couldn't start Claude Code",
        `${errorMessage(error)}. Make sure \`${binary}\` works in your terminal; updating with \`claude update\` may help.`,
      );
    }
  }

  private async ensureSession(request: SendRequest): Promise<LiveSession> {
    const live = this.sessions.get(request.conversationId);
    if (live?.process.isAlive && live.turns === request.history.length) return live;
    this.dropSession(request.conversationId);

    const instructions =
      request.history.length > 0
        ? `${request.instructions}\n\n${formatTranscript(request.history)}`
        : request.instructions;
    const { process: claude } = await this.start({ instructions, webSearch: request.webSearch });
    const session: LiveSession = {
      process: claude,
      settings: DEFAULT_SETTINGS,
      turns: request.history.length,
      busy: false,
      lastUsed: Date.now(),
    };
    this.sessions.set(request.conversationId, session);
    claude.onExit(() => {
      if (this.sessions.get(request.conversationId) === session) this.sessions.delete(request.conversationId);
    });
    this.closeIdleSessions(request.conversationId);
    return session;
  }

  /** Model, effort and fast mode can change between turns without losing the conversation (or its cache). */
  private async applySettings(live: LiveSession, request: SendRequest) {
    const settings: FlagSettings = {
      model: request.model ?? null,
      effortLevel: request.reasoningEffort ?? null,
      fastMode: request.fast || null,
    };
    const changed = (Object.keys(settings) as (keyof FlagSettings)[]).filter(
      (key) => settings[key] !== live.settings[key],
    );
    if (changed.length === 0) return;
    await live.process.request("apply_flag_settings", {
      settings: Object.fromEntries(changed.map((key) => [key, settings[key]])),
    });
    live.settings = settings;
  }

  private runTurn(claude: ClaudeProcess, request: SendRequest): Promise<SendResult> {
    return new Promise<SendResult>((resolve, reject) => {
      const activity = new TurnActivity();
      let interruptRequested = false;
      let assistantError: AssistantError | undefined;
      let settled = false;

      const emit = () => request.onUpdate?.({ text: activity.text, steps: activity.stepList });
      const onAbort = () => {
        interruptRequested = true;
        claude.request("interrupt").catch(() => undefined);
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        stopListening();
        stopWatchingExit();
        request.signal?.removeEventListener("abort", onAbort);
        finish();
      };

      const stopListening = claude.onMessage((message) => {
        switch (message.type) {
          case "rate_limit_event":
            this.limits = toUsageLimits(message.rate_limit_info) ?? this.limits;
            break;
          case "assistant":
            if (message.error && !message.parent_tool_use_id) assistantError = message.error;
            if (activity.apply(message)) emit();
            break;
          case "result": {
            activity.apply(message);
            if (message.is_error && !interruptRequested) {
              activity.finish("failed");
              const text = message.result?.trim() || "Claude Code couldn't finish the answer";
              settle(() => reject(new ProviderError(text, errorHint(assistantError))));
            } else {
              activity.finish(message.is_error ? "failed" : "done");
              settle(() =>
                resolve({
                  text: activity.text,
                  steps: activity.stepList,
                  usage: activity.tokenUsage,
                  limits: this.limits,
                  interrupted: interruptRequested && message.is_error,
                }),
              );
            }
            break;
          }
          default:
            if (activity.apply(message)) emit();
        }
      });
      const stopWatchingExit = claude.onExit((error) => settle(() => reject(error)));
      request.signal?.addEventListener("abort", onAbort, { once: true });

      claude.sendUserMessage(request.prompt);
    });
  }

  private dropSession(conversationId: string) {
    const live = this.sessions.get(conversationId);
    if (!live) return;
    this.sessions.delete(conversationId);
    live.process.close();
  }

  private closeIdleSessions(keep: string) {
    const idle = [...this.sessions]
      .filter(([conversationId, session]) => conversationId !== keep && !session.busy)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    let excess = this.sessions.size - MAX_LIVE_SESSIONS;
    for (const [conversationId] of idle) {
      if (excess-- <= 0) break;
      this.dropSession(conversationId);
    }
  }
}

/**
 * The CLI lists "default" (whatever the user configured), aliases for the latest models ("opus", "sonnet", …)
 * and full names of older ones. The alias the default resolves to is marked as the default instead.
 */
function toModelInfos(models: CliModel[]): ModelInfo[] {
  const fallback = models.find((model) => model.value === "default");
  const listed = models.filter((model) => model.value !== "default");
  const defaultModel =
    listed.find((model) => !model.value.startsWith("claude-") && model.resolvedModel === fallback?.resolvedModel) ??
    listed.find((model) => model.resolvedModel === fallback?.resolvedModel);
  return listed.map((model) => ({
    id: model.value,
    name: model.displayName,
    description: model.description,
    group: model.value.startsWith("claude-") ? "Older Models" : undefined,
    isDefault: model === defaultModel,
    reasoningEfforts: (model.supportsEffort ? (model.supportedEffortLevels ?? []) : []).map((id) => ({ id })),
    fastMode: model.supportsFastMode ? { description: "Faster output, billed as extra usage" } : undefined,
  }));
}

function toUsageLimits(info: RateLimitInfo): UsageLimit[] | undefined {
  const windows = Object.entries(info.unifiedWindows ?? {}).filter(
    ([, window]) => typeof window.utilization === "number",
  );
  if (windows.length === 0) return undefined;
  return windows.map(([name, window]) => ({
    usedPercent: (window.utilization ?? 0) * 100,
    windowMinutes: LIMIT_WINDOWS[name],
    resetsAt: window.resetsAt,
  }));
}

function errorHint(error: AssistantError | undefined): string | undefined {
  switch (error) {
    case "authentication_failed":
      return "Run `claude` in your terminal and sign in with /login, then try again.";
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
    case "billing_error":
      return "Check your Claude account by running `claude` in your terminal.";
    case "rate_limit":
      return "You've reached your Claude usage limit. Wait for it to reset or pick another provider with ⌘⇧A.";
    case "overloaded":
    case "server_error":
      return "Claude is having trouble right now. Try again in a moment.";
    case "model_not_found":
      return "This model isn't available to your account. Pick another one with ⌘⇧M.";
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
}
