import { showToast, Toast } from "@raycast/api";
import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { buildInstructions } from "../lib/settings";
import { saveConversation } from "../lib/storage";
import type { Conversation, Exchange } from "../lib/types";
import { ProviderError, type HistoryTurn, type ProviderId, type StreamUpdate } from "../providers/types";
import { useModelSettings, type ModelSettings } from "./useModelSettings";

export interface Chat {
  conversation: Conversation;
  modelSettings: ModelSettings;
  isStreaming: boolean;
  /** Changes whenever the conversation was written to storage. */
  savedAt: number;
  send: (prompt: string) => void;
  /** Asks the question of an exchange again, dropping it and everything after it. */
  retry: (exchangeId: string) => void;
  stop: () => void;
  open: (conversation: Conversation) => void;
  startNew: () => void;
  /** Start saving this conversation to the chat history. */
  persist: () => void;
}

/** How long streamed updates are buffered before re-rendering. Tokens arrive far faster than that. */
const RENDER_INTERVAL_MS = 75;

export function useChat(options: { persist?: boolean } = {}): Chat {
  const modelSettings = useModelSettings();
  const { settings, provider } = modelSettings;
  const [conversation, setConversation] = useState(() => createConversation(provider.id));
  const [isPersistent, setPersistent] = useState(options.persist ?? false);
  const [savedAt, setSavedAt] = useState(0);
  const abortController = useRef<AbortController | null>(null);

  // No abort on cleanup: Raycast renders in StrictMode during development, which runs this cleanup right after
  // mounting and would cancel the first question. Views that leave a running answer behind stop it explicitly,
  // and the agent process ends together with the command.
  useEffect(() => {
    provider.warmUp();
  }, [provider]);

  const isStreaming = conversation.exchanges.some((exchange) => exchange.status === "streaming");

  useEffect(() => {
    if (!isPersistent || isStreaming || conversation.exchanges.length === 0) return;
    saveConversation(conversation).then(() => setSavedAt(Date.now()));
  }, [conversation, isPersistent, isStreaming]);

  async function run(rawPrompt: string, previous: Exchange[]) {
    const prompt = rawPrompt.trim();
    if (!prompt) return;
    if (abortController.current) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Still answering",
        message: "Stop the current answer first",
      });
      return;
    }

    const controller = new AbortController();
    abortController.current = controller;
    const conversationId = conversation.id;
    const choice = modelSettings.choice;
    const exchange: Exchange = {
      id: randomUUID(),
      prompt,
      answer: "",
      status: "streaming",
      createdAt: Date.now(),
      choice,
      steps: [],
    };
    setConversation((current) => ({
      ...current,
      title: previous.length === 0 ? titleFor(prompt) : current.title,
      updatedAt: Date.now(),
      exchanges: [...previous, exchange],
    }));

    const update = (changes: Partial<Exchange>) =>
      setConversation((current) =>
        current.id !== conversationId
          ? current
          : {
              ...current,
              exchanges: current.exchanges.map((item) => (item.id === exchange.id ? { ...item, ...changes } : item)),
            },
      );

    // Detached runs (the user switched conversations) must not touch shared state anymore.
    const isCurrent = () => abortController.current === controller;

    let pending: StreamUpdate | undefined;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending || !isCurrent()) return;
      update({ answer: pending.text, steps: pending.steps });
      pending = undefined;
    };
    const stopFlushing = () => {
      clearTimeout(timer);
      pending = undefined;
    };

    try {
      const result = await provider.send({
        conversationId,
        history: toHistory(previous),
        prompt,
        model: choice.model,
        reasoningEffort: choice.effort,
        fast: choice.fast,
        instructions: buildInstructions(settings),
        webSearch: settings.webSearch,
        signal: controller.signal,
        onUpdate: (next) => {
          pending = next;
          timer ??= setTimeout(flush, RENDER_INTERVAL_MS);
        },
      });
      stopFlushing();
      update({
        answer: result.text,
        steps: result.steps,
        usage: result.usage,
        limits: result.limits,
        status: result.interrupted ? "cancelled" : "done",
        completedAt: Date.now(),
      });
    } catch (error) {
      stopFlushing();
      const title = error instanceof Error ? error.message : String(error);
      const hint = error instanceof ProviderError ? error.hint : undefined;
      update({
        status: "error",
        error: hint ? `**${title}**\n\n${hint}` : `**${title}**`,
        completedAt: Date.now(),
      });
      if (isCurrent()) await showToast({ style: Toast.Style.Failure, title, message: hint });
    } finally {
      if (isCurrent()) abortController.current = null;
    }
  }

  /** Abort a running answer without blocking new messages, e.g. when switching to another conversation. */
  function detach() {
    abortController.current?.abort();
    abortController.current = null;
  }

  return {
    conversation,
    modelSettings,
    isStreaming,
    savedAt,
    send: (prompt) => void run(prompt, conversation.exchanges),
    retry: (exchangeId) => {
      const index = conversation.exchanges.findIndex((exchange) => exchange.id === exchangeId);
      if (index !== -1) void run(conversation.exchanges[index].prompt, conversation.exchanges.slice(0, index));
    },
    stop: () => abortController.current?.abort(),
    open: (next) => {
      detach();
      setConversation(next);
    },
    startNew: () => {
      detach();
      setConversation(createConversation(provider.id));
    },
    persist: () => setPersistent(true),
  };
}

function createConversation(providerId: ProviderId): Conversation {
  const now = Date.now();
  return { id: randomUUID(), title: "New Chat", providerId, createdAt: now, updatedAt: now, exchanges: [] };
}

function titleFor(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Only answered exchanges are context; failed ones never reached the agent's memory in a usable form. */
function toHistory(exchanges: Exchange[]): HistoryTurn[] {
  return exchanges
    .filter((exchange) => exchange.status === "done" || (exchange.status === "cancelled" && exchange.answer))
    .map((exchange) => ({ prompt: exchange.prompt, answer: exchange.answer }));
}
