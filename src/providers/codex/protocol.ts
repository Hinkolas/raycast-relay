/**
 * The subset of the Codex app-server protocol this extension uses.
 * Full bindings can be generated with `codex app-server generate-ts --out <dir>`.
 */

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean } | null;
}

export interface GetAccountResponse {
  account: { type: string } | null;
  requiresOpenaiAuth: boolean;
}

export interface Model {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  serviceTiers?: { id: string; name: string; description: string }[];
}

export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}

export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: "untrusted" | "on-request" | "never" | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  config?: { web_search?: WebSearchMode } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
}

export interface ThreadStartResponse {
  thread: { id: string };
  model: string;
}

export interface TurnStartParams {
  threadId: string;
  input: { type: "text"; text: string; text_elements: [] }[];
  model?: string | null;
  effort?: string | null;
  summary?: "auto" | "concise" | "detailed" | "none" | null;
  /** Service tier for this turn only; "default" is standard speed. */
  serviceTierForTurn?: string | null;
}

export interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string; additionalDetails: string | null } | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export type WebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[] }
  | { type: "webSearch"; id: string; query: string; action: WebSearchAction | null }
  | { type: "commandExecution"; id: string; command: string; status: string; exitCode: number | null }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string; error: unknown }
  | { type: "fileChange"; id: string; status: string }
  | { type: "other"; id: string };

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

type TurnScoped<T> = { threadId: string; turnId: string } & T;

/** Notifications the provider reacts to. Every other notification is ignored. */
export type ServerNotification =
  | { method: "turn/started"; params: { threadId: string; turn: Turn } }
  | { method: "turn/completed"; params: { threadId: string; turn: Turn } }
  | { method: "item/started"; params: TurnScoped<{ item: ThreadItem }> }
  | { method: "item/completed"; params: TurnScoped<{ item: ThreadItem }> }
  | { method: "item/agentMessage/delta"; params: TurnScoped<{ itemId: string; delta: string }> }
  | {
      method: "item/reasoning/summaryTextDelta";
      params: TurnScoped<{ itemId: string; delta: string; summaryIndex: number }>;
    }
  | { method: "thread/tokenUsage/updated"; params: TurnScoped<{ tokenUsage: { last: TokenUsageBreakdown } }> }
  | { method: "error"; params: TurnScoped<{ willRetry: boolean; error: { message: string } }> }
  | { method: "account/rateLimits/updated"; params: { threadId?: undefined; rateLimits: RateLimitSnapshot } };
