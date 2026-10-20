import type { AgentStep, StepKind, TokenUsage } from "../types";
import type { ServerEvent } from "./protocol";

interface ToolStyle {
  kind: StepKind;
  running: string;
  done: string;
}

const TOOL_STYLES: Record<string, ToolStyle> = {
  websearch: { kind: "search", running: "Searching the web", done: "Searched the web" },
  webfetch: { kind: "browse", running: "Reading a page", done: "Read a page" },
  bash: { kind: "command", running: "Running a command", done: "Ran a command" },
  shell: { kind: "command", running: "Running a command", done: "Ran a command" },
  execute: { kind: "command", running: "Running a command", done: "Ran a command" },
  edit: { kind: "edit", running: "Editing files", done: "Edited files" },
  write: { kind: "edit", running: "Editing files", done: "Edited files" },
  patch: { kind: "edit", running: "Editing files", done: "Edited files" },
};

/**
 * Turns the events of one OpenCode turn into the answer text, a list of steps (searches, pages, reasoning, tool
 * calls) and the token usage. A turn runs several model steps, e.g. one that searches and one that answers.
 */
export class TurnActivity {
  /** Text parts by message and position, in the order they started; together they form the answer. */
  private readonly texts = new Map<string, string>();
  private readonly steps = new Map<string, AgentStep>();
  private readonly reasoning = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  private usage: TokenUsage | undefined;

  /** Applies an event; returns true when the visible state changed. */
  apply(event: ServerEvent): boolean {
    const now = Date.now();
    switch (event.type) {
      case "session.text.started":
        this.texts.set(partKey(event.data), this.texts.get(partKey(event.data)) ?? "");
        return false;
      case "session.text.delta": {
        const key = partKey(event.data);
        this.texts.set(key, (this.texts.get(key) ?? "") + event.data.delta);
        return true;
      }
      case "session.text.ended":
        this.texts.set(partKey(event.data), event.data.text);
        return true;

      case "session.reasoning.started": {
        const id = `reasoning:${partKey(event.data)}`;
        this.steps.set(id, { id, kind: "thinking", title: "Thinking", status: "running", startedAt: now });
        return true;
      }
      case "session.reasoning.delta": {
        const id = `reasoning:${partKey(event.data)}`;
        const text = (this.reasoning.get(id) ?? "") + event.data.delta;
        this.reasoning.set(id, text);
        const step = this.steps.get(id);
        const title = reasoningTitle(text);
        if (step && title && title !== step.title) {
          step.title = title;
          return true;
        }
        return false;
      }
      case "session.reasoning.ended": {
        const id = `reasoning:${partKey(event.data)}`;
        const step = this.steps.get(id);
        if (!step) return false;
        step.status = "done";
        step.completedAt = now;
        step.title = reasoningTitle(event.data.text) ?? "Thought";
        return true;
      }

      case "session.tool.input.started": {
        const { id, name } = event.data;
        const style = toolStyle(name);
        this.toolNames.set(id, name);
        this.steps.set(id, { id, kind: style.kind, title: style.running, status: "running", startedAt: now });
        return true;
      }
      case "session.tool.called": {
        const step = this.steps.get(event.data.id);
        if (!step) return false;
        Object.assign(step, describeInput(this.toolNames.get(event.data.id), event.data.input));
        return true;
      }
      case "session.tool.success": {
        const step = this.steps.get(event.data.id);
        if (!step) return false;
        step.status = "done";
        step.completedAt = now;
        step.title = toolStyle(this.toolNames.get(event.data.id)).done;
        return true;
      }
      case "session.tool.failed": {
        // Malformed calls never ran; the model retries them, so they're noise rather than a failure.
        if (event.data.error?.type === "tool.input-json") return this.steps.delete(event.data.id);
        const step = this.steps.get(event.data.id);
        if (!step) return false;
        step.status = "failed";
        step.completedAt = now;
        return true;
      }

      case "session.step.ended": {
        const tokens = event.data.tokens;
        if (!tokens) return false;
        this.usage = {
          input: (this.usage?.input ?? 0) + tokens.input + tokens.cache.read + tokens.cache.write,
          cachedInput: (this.usage?.cachedInput ?? 0) + tokens.cache.read,
          output: (this.usage?.output ?? 0) + tokens.output,
          reasoning: (this.usage?.reasoning ?? 0) + tokens.reasoning,
        };
        return false;
      }
      default:
        return false;
    }
  }

  get text(): string {
    return [...this.texts.values()]
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
}

function partKey(part: { assistantMessageID: string; ordinal: number }): string {
  return `${part.assistantMessageID}:${part.ordinal}`;
}

function toolStyle(name: string | undefined): ToolStyle {
  if (name && TOOL_STYLES[name]) return TOOL_STYLES[name];
  const label = name ? name.replace(/[_-]+/g, " ") : "a tool";
  return { kind: "tool", running: `Using ${label}`, done: `Used ${label}` };
}

function describeInput(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): Pick<AgentStep, "detail" | "url"> {
  const string = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : undefined);
  switch (name) {
    case "websearch":
      return { detail: string("query") };
    case "webfetch": {
      const url = string("url");
      return { detail: hostname(url), url };
    }
    case "bash":
    case "shell":
    case "execute":
      return { detail: string("command") };
    default:
      return { detail: string("description") ?? string("filePath") ?? string("path") };
  }
}

/** Some models title their reasoning with bold lines, e.g. "**Comparing sources**"; the latest one wins. */
function reasoningTitle(text: string): string | undefined {
  const titles = [...text.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,60})\*\*\s*(?=\n|$)/g)];
  return titles.at(-1)?.[1].trim() || undefined;
}

function hostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
