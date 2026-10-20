import type { Conversation, Exchange } from "./types";

/** The question as a quote, followed by the answer (or what the agent is doing while there is none yet). */
export function exchangeMarkdown(exchange: Exchange, activity?: string): string {
  const parts = [quote(exchange.prompt)];
  if (exchange.answer) parts.push(exchange.answer);

  switch (exchange.status) {
    case "streaming":
      if (activity || !exchange.answer) parts.push(`_${activity ?? "Thinking…"}_`);
      break;
    case "cancelled":
      parts.push("_Stopped._");
      break;
    case "error":
      parts.push(exchange.error ?? "**Something went wrong**");
      break;
  }
  return parts.join("\n\n");
}

/** The whole conversation as Markdown, for copying. */
export function conversationMarkdown(conversation: Conversation): string {
  return conversation.exchanges
    .filter((exchange) => exchange.answer)
    .map((exchange) => `${quote(exchange.prompt)}\n\n${exchange.answer}`)
    .join("\n\n---\n\n");
}

export function firstLine(text: string): string {
  return text.trim().split("\n")[0];
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
