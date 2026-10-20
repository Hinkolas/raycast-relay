import { LocalStorage } from "@raycast/api";
import type { ProviderId } from "../providers/types";
import type { Conversation } from "./types";

const CONVERSATIONS_KEY = "conversations";
const MAX_CONVERSATIONS = 100;

// Read-modify-write operations are queued so concurrent saves can't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}

export async function loadConversations(): Promise<Conversation[]> {
  const raw = await LocalStorage.getItem<string>(CONVERSATIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeConversations(conversations: Conversation[]) {
  await LocalStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

export function saveConversation(conversation: Conversation): Promise<void> {
  return serialized(async () => {
    const others = (await loadConversations()).filter((existing) => existing.id !== conversation.id);
    const next = [conversation, ...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
    await writeConversations(next);
  });
}

export function deleteConversation(id: string): Promise<void> {
  return serialized(async () => {
    await writeConversations((await loadConversations()).filter((conversation) => conversation.id !== id));
  });
}

export function deleteAllConversations(): Promise<void> {
  return serialized(() => LocalStorage.removeItem(CONVERSATIONS_KEY));
}

/** The model picked in "Change Model" applies to every chat of a provider; `undefined` is the provider default. */
export async function getSelectedModel(providerId: ProviderId): Promise<string | undefined> {
  return (await LocalStorage.getItem<string>(`model:${providerId}`)) || undefined;
}

export async function setSelectedModel(providerId: ProviderId, model: string | undefined) {
  if (model) {
    await LocalStorage.setItem(`model:${providerId}`, model);
  } else {
    await LocalStorage.removeItem(`model:${providerId}`);
  }
}
