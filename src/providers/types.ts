/**
 * Provider abstraction. A provider wraps a locally installed agent harness (Codex CLI today; Claude Code,
 * OpenCode, … later) and turns it into a plain "send a message, stream the answer" interface.
 *
 * Providers must not import `@raycast/api`, so they stay testable from plain Node.
 */

export type ProviderId = "codex";

/** A completed question/answer pair, used to give the agent the earlier context of a conversation. */
export interface HistoryTurn {
  prompt: string;
  answer: string;
}

export interface StreamUpdate {
  /** The full answer text received so far. */
  text: string;
  /** What the agent is doing right now when it isn't writing, e.g. "Searching the web…". */
  activity?: string;
}

export interface SendRequest {
  /** Stable id of the conversation, so providers can keep a live session between turns. */
  conversationId: string;
  /** Earlier completed turns of the conversation, oldest first. */
  history: HistoryTurn[];
  prompt: string;
  /** Model id; `undefined` uses the provider's own default. */
  model?: string;
  /** Reasoning effort; `undefined` uses the model's default. */
  reasoningEffort?: string;
  /** System instructions that replace the harness' coding-agent prompt. */
  instructions: string;
  webSearch: boolean;
  signal?: AbortSignal;
  onUpdate?: (update: StreamUpdate) => void;
}

export interface SendResult {
  text: string;
  /** True when the turn was stopped through `signal` before it finished. */
  interrupted: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  /** Start anything slow (processes, auth checks) ahead of the first message. */
  warmUp(): void;
  listModels(): Promise<ModelInfo[]>;
  send(request: SendRequest): Promise<SendResult>;
}

/** An error with a user-facing hint on how to fix it. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
