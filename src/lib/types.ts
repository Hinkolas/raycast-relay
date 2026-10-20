import type { ProviderId } from "../providers/types";

export type ExchangeStatus = "streaming" | "done" | "cancelled" | "error";

/** One question and its answer. Chats are a list of exchanges, which maps directly onto Raycast list items. */
export interface Exchange {
  id: string;
  prompt: string;
  answer: string;
  status: ExchangeStatus;
  error?: string;
  /** Model that answered; `undefined` when the provider default was used. */
  model?: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  providerId: ProviderId;
  createdAt: number;
  updatedAt: number;
  exchanges: Exchange[];
}
