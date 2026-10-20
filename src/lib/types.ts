import type { AgentStep, ProviderId, TokenUsage, UsageLimit } from "../providers/types";

export type ExchangeStatus = "streaming" | "done" | "cancelled" | "error";

/** The model configuration an answer was requested with. */
export interface ModelChoice {
  /** Model id; `undefined` is the provider default. */
  model?: string;
  modelName?: string;
  /** Reasoning effort id; `undefined` is the model default. */
  effort?: string;
  fast: boolean;
}

/** One question and its answer. Chats are a list of exchanges, which maps directly onto Raycast list items. */
export interface Exchange {
  id: string;
  prompt: string;
  answer: string;
  status: ExchangeStatus;
  error?: string;
  createdAt: number;
  completedAt?: number;
  choice?: ModelChoice;
  steps?: AgentStep[];
  usage?: TokenUsage;
  limits?: UsageLimit[];
}

export interface Conversation {
  id: string;
  title: string;
  providerId: ProviderId;
  createdAt: number;
  updatedAt: number;
  exchanges: Exchange[];
}
