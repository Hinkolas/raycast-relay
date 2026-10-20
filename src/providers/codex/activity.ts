import type { AgentStep, TokenUsage } from "../types";
import type { ServerNotification, ThreadItem, WebSearchAction } from "./protocol";

/**
 * Turns the notifications of one Codex turn into the answer text, a list of steps (searches, reasoning, tool
 * calls) and the token usage.
 */
export class TurnActivity {
  /** Agent messages by item id, in the order they started; together they form the answer. */
  private readonly messages = new Map<string, string>();
  private readonly steps = new Map<string, AgentStep>();
  /** Reasoning summary parts per reasoning item; each part usually starts with a bold title. */
  private readonly summaries = new Map<string, string[]>();
  private usage: TokenUsage | undefined;

  /** Applies a notification; returns true when the visible state changed. */
  apply(notification: ServerNotification): boolean {
    switch (notification.method) {
      case "item/started":
        return this.itemStarted(notification.params.item);
      case "item/completed":
        return this.itemCompleted(notification.params.item);
      case "item/agentMessage/delta": {
        const { itemId, delta } = notification.params;
        this.messages.set(itemId, (this.messages.get(itemId) ?? "") + delta);
        return true;
      }
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta, summaryIndex } = notification.params;
        const parts = this.summaries.get(itemId) ?? [];
        parts[summaryIndex] = (parts[summaryIndex] ?? "") + delta;
        this.summaries.set(itemId, parts);
        const step = this.steps.get(itemId);
        const title = summaryTitle(parts[summaryIndex]);
        if (step && title && title !== step.title) {
          step.title = title;
          return true;
        }
        return false;
      }
      case "thread/tokenUsage/updated": {
        // `last` covers a single model request; a turn can make several (e.g. around web searches).
        const { last } = notification.params.tokenUsage;
        this.usage = {
          input: (this.usage?.input ?? 0) + last.inputTokens,
          cachedInput: (this.usage?.cachedInput ?? 0) + last.cachedInputTokens,
          output: (this.usage?.output ?? 0) + last.outputTokens,
          reasoning: (this.usage?.reasoning ?? 0) + last.reasoningOutputTokens,
        };
        return false;
      }
      default:
        return false;
    }
  }

  get text(): string {
    return [...this.messages.values()]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  get stepList(): AgentStep[] {
    return [...this.steps.values()].map((step) => ({ ...step }));
  }

  get tokenUsage(): TokenUsage | undefined {
    return this.usage;
  }

  /** Marks steps that never completed (e.g. because the turn was stopped). */
  finish(status: AgentStep["status"]) {
    const now = Date.now();
    for (const step of this.steps.values()) {
      if (step.status !== "running") continue;
      step.status = status;
      step.completedAt = now;
    }
  }

  private itemStarted(item: ThreadItem): boolean {
    const now = Date.now();
    const start = (step: Omit<AgentStep, "id" | "status" | "startedAt">) => {
      this.steps.set(item.id, { id: item.id, status: "running", startedAt: now, ...step });
      return true;
    };

    switch (item.type) {
      case "agentMessage":
        this.messages.set(item.id, this.messages.get(item.id) ?? "");
        return false;
      case "reasoning":
        return start({ kind: "thinking", title: "Thinking" });
      case "webSearch":
        return start({ kind: "search", title: "Searching the web" });
      case "commandExecution":
        return start({ kind: "command", title: "Running a command", detail: item.command });
      case "mcpToolCall":
        return start({ kind: "tool", title: `Using ${item.server}`, detail: item.tool });
      case "fileChange":
        return start({ kind: "edit", title: "Editing files" });
      default:
        return false;
    }
  }

  private itemCompleted(item: ThreadItem): boolean {
    if (item.type === "agentMessage") {
      this.messages.set(item.id, item.text);
      return true;
    }

    const step = this.steps.get(item.id);
    if (!step) return false;
    step.status = "done";
    step.completedAt = Date.now();

    switch (item.type) {
      case "reasoning": {
        const parts = item.summary.length > 0 ? item.summary : (this.summaries.get(item.id) ?? []);
        step.title = summaryTitle(parts.at(-1)) ?? "Thought";
        break;
      }
      case "webSearch":
        Object.assign(step, describeWebSearch(item.action, item.query));
        break;
      case "commandExecution":
        step.title = "Ran a command";
        if (item.exitCode !== null && item.exitCode !== 0) step.status = "failed";
        break;
      case "mcpToolCall":
        step.title = `Used ${item.server}`;
        if (item.error) step.status = "failed";
        break;
      case "fileChange":
        step.title = "Edited files";
        break;
    }
    return true;
  }
}

function describeWebSearch(
  action: WebSearchAction | null,
  query: string,
): Pick<AgentStep, "kind" | "title" | "detail" | "url"> {
  switch (action?.type) {
    case "openPage":
      return { kind: "browse", title: "Read a page", detail: hostname(action.url), url: action.url ?? undefined };
    case "findInPage":
      return {
        kind: "browse",
        title: "Searched a page",
        detail: action.pattern ?? hostname(action.url),
        url: action.url ?? undefined,
      };
    case "search":
      return {
        kind: "search",
        title: "Searched the web",
        detail: action.query ?? action.queries?.join(", ") ?? (query || undefined),
      };
    default:
      return { kind: "search", title: "Searched the web", detail: query || undefined };
  }
}

/** Reasoning summaries start with a bold title, e.g. "**Comparing sources**\n\nI want to…". */
function summaryTitle(summary: string | undefined): string | undefined {
  const match = summary?.match(/^\s*\*\*(.+?)\*\*/);
  return match?.[1].trim() || undefined;
}

function hostname(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
