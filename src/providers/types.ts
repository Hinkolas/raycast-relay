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

export type StepKind = "thinking" | "search" | "browse" | "command" | "tool" | "edit";

/** Something the agent did while answering, e.g. a web search or a reasoning phase. */
export interface AgentStep {
  id: string;
  kind: StepKind;
  /** Short description, e.g. "Searched the web" or a reasoning summary title like "Comparing sources". */
  title: string;
  /** Extra context such as the search query or the page that was read. */
  detail?: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  completedAt?: number;
}

export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** How much of a subscription's usage window is used up, e.g. 12% of the weekly limit. */
export interface UsageLimit {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface StreamUpdate {
  /** The full answer text received so far. */
  text: string;
  steps: AgentStep[];
}

export interface SendRequest {
  /** Stable id of the conversation, so providers can keep a live session between turns. */
  conversationId: string;
  /** Earlier completed turns of the conversation, oldest first. */
  history: HistoryTurn[];
  prompt: string;
  /** Model id; `undefined` uses the provider's own default. */
  model?: string;
  /** Reasoning effort id from `ModelInfo.reasoningEfforts`; `undefined` uses the model's default. */
  reasoningEffort?: string;
  /** Use the model's faster (usually more expensive) service tier, when it has one. */
  fast: boolean;
  /** System instructions that replace the harness' coding-agent prompt. */
  instructions: string;
  webSearch: boolean;
  signal?: AbortSignal;
  onUpdate?: (update: StreamUpdate) => void;
}

export interface SendResult {
  text: string;
  steps: AgentStep[];
  usage?: TokenUsage;
  limits?: UsageLimit[];
  /** True when the turn was stopped through `signal` before it finished. */
  interrupted: boolean;
}

export interface ReasoningEffortOption {
  id: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  reasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort?: string;
  /** Present when the model offers a fast mode; describes its trade-off, e.g. "2x speed, increased usage". */
  fastMode?: { description?: string };
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
