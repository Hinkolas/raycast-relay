import { showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { randomUUID } from "node:crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildInstructions, getProvider, getSettings } from "../lib/settings";
import { getSelectedModel, saveConversation, setSelectedModel } from "../lib/storage";
import type { Conversation, Exchange } from "../lib/types";
import { ProviderError, type HistoryTurn, type ModelInfo, type Provider, type ProviderId } from "../providers/types";

export interface Chat {
  conversation: Conversation;
  provider: Provider;
  /** Selected model id; `undefined` means the provider's default. */
  model: string | undefined;
  models: ModelInfo[];
  isStreaming: boolean;
  /** What the agent is doing while it isn't writing, e.g. "Searching the web…". */
  activity: string | undefined;
  /** Changes whenever the conversation was written to storage. */
  savedAt: number;
  send: (prompt: string) => void;
  /** Asks the question of an exchange again, dropping it and everything after it. */
  retry: (exchangeId: string) => void;
  stop: () => void;
  setModel: (model: string | undefined) => void;
  open: (conversation: Conversation) => void;
  startNew: () => void;
  /** Start saving this conversation to the chat history. */
  persist: () => void;
}

/** How long streamed text is buffered before re-rendering. Tokens arrive far faster than that. */
const RENDER_INTERVAL_MS = 75;

export function useChat(options: { persist?: boolean } = {}): Chat {
  const settings = useMemo(getSettings, []);
  const provider = useMemo(() => getProvider(settings), [settings]);
  const [conversation, setConversation] = useState(() => createConversation(settings.providerId));
  const [isPersistent, setPersistent] = useState(options.persist ?? false);
  const [activity, setActivity] = useState<string>();
  const [model, setModelState] = useState<string>();
  const [savedAt, setSavedAt] = useState(0);
  const modelPromise = useRef<Promise<string | undefined>>(undefined);
  const abortController = useRef<AbortController | null>(null);

  const { data: models = [] } = useCachedPromise(() => provider.listModels(), [], {
    keepPreviousData: true,
    // Setup problems (Codex missing, signed out) are reported when sending; no need for a second toast.
    onError: () => undefined,
  });

  useEffect(() => {
    provider.warmUp();
    const selected = getSelectedModel(settings.providerId);
    modelPromise.current = selected;
    selected.then(setModelState);
    return () => abortController.current?.abort();
  }, []);

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
    const exchange: Exchange = { id: randomUUID(), prompt, answer: "", status: "streaming", createdAt: Date.now() };
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

    let pending: { text: string; activity?: string } | undefined;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending || !isCurrent()) return;
      update({ answer: pending.text });
      setActivity(pending.activity);
      pending = undefined;
    };
    const stopFlushing = () => {
      clearTimeout(timer);
      pending = undefined;
    };

    try {
      const selectedModel = await modelPromise.current;
      const result = await provider.send({
        conversationId,
        history: toHistory(previous),
        prompt,
        model: selectedModel,
        reasoningEffort: settings.reasoningEffort,
        instructions: buildInstructions(settings),
        webSearch: settings.webSearch,
        signal: controller.signal,
        onUpdate: (next) => {
          pending = next;
          timer ??= setTimeout(flush, RENDER_INTERVAL_MS);
        },
      });
      stopFlushing();
      update({ answer: result.text, status: result.interrupted ? "cancelled" : "done", model: selectedModel });
    } catch (error) {
      stopFlushing();
      const title = error instanceof Error ? error.message : String(error);
      const hint = error instanceof ProviderError ? error.hint : undefined;
      update({ status: "error", error: hint ? `**${title}**\n\n${hint}` : `**${title}**` });
      if (isCurrent()) await showToast({ style: Toast.Style.Failure, title, message: hint });
    } finally {
      if (isCurrent()) {
        abortController.current = null;
        setActivity(undefined);
      }
    }
  }

  /** Abort a running answer without blocking new messages, e.g. when switching to another conversation. */
  function detach() {
    abortController.current?.abort();
    abortController.current = null;
    setActivity(undefined);
  }

  return {
    conversation,
    provider,
    model,
    models,
    isStreaming,
    activity,
    savedAt,
    send: (prompt) => void run(prompt, conversation.exchanges),
    retry: (exchangeId) => {
      const index = conversation.exchanges.findIndex((exchange) => exchange.id === exchangeId);
      if (index !== -1) void run(conversation.exchanges[index].prompt, conversation.exchanges.slice(0, index));
    },
    stop: () => abortController.current?.abort(),
    setModel: (next) => {
      setModelState(next);
      modelPromise.current = Promise.resolve(next);
      void setSelectedModel(settings.providerId, next);
    },
    open: (next) => {
      detach();
      setConversation(next);
    },
    startNew: () => {
      detach();
      setConversation(createConversation(settings.providerId));
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
