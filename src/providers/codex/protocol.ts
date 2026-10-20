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

export interface ModelListResponse {
  data: {
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    isDefault: boolean;
  }[];
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
}

export interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string; additionalDetails: string | null } | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string }
  | { type: "webSearch"; id: string; query: string }
  | { type: "commandExecution"; id: string; command: string }
  | { type: "mcpToolCall"; id: string; server: string; tool: string }
  | { type: "fileChange"; id: string }
  | { type: string; id: string };

/** Notifications the provider reacts to. Every other notification is ignored. */
export type ServerNotification =
  | { method: "turn/started"; params: { threadId: string; turn: Turn } }
  | { method: "turn/completed"; params: { threadId: string; turn: Turn } }
  | { method: "item/started"; params: { threadId: string; turnId: string; item: ThreadItem } }
  | { method: "item/completed"; params: { threadId: string; turnId: string; item: ThreadItem } }
  | { method: "item/agentMessage/delta"; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | {
      method: "error";
      params: { threadId: string; turnId: string; willRetry: boolean; error: { message: string } };
    };
