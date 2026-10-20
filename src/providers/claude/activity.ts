import type { AgentStep, StepKind, TokenUsage } from "../types";
import type { ContentBlock, OutputMessage, StreamEvent } from "./protocol";

interface ToolStyle {
  kind: StepKind;
  running: string;
  done: string;
}

const TOOL_STYLES: Record<string, ToolStyle> = {
  WebSearch: { kind: "search", running: "Searching the web", done: "Searched the web" },
  WebFetch: { kind: "browse", running: "Reading a page", done: "Read a page" },
  Bash: { kind: "command", running: "Running a command", done: "Ran a command" },
  Edit: { kind: "edit", running: "Editing files", done: "Edited files" },
  Write: { kind: "edit", running: "Editing files", done: "Edited files" },
};

/**
 * Turns the messages of one Claude Code turn into the answer text, a list of steps (searches, pages, reasoning,
 * tool calls) and the token usage. A turn makes several model requests, e.g. one that searches and one that
 * answers; each streams its content blocks.
 */
export class TurnActivity {
  /** Text blocks by message and position, in the order they started; together they form the answer. */
  private readonly texts = new Map<string, string>();
  private readonly steps = new Map<string, AgentStep>();
  private readonly reasoning = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  /** Content blocks of the message that's streaming, by index: the key of their text or step. */
  private readonly blocks = new Map<number, { type: ContentBlock["type"]; key: string }>();
  private messageId = "";
  private usage: TokenUsage | undefined;

  /** Applies a message; returns true when the visible state changed. */
  apply(message: OutputMessage): boolean {
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return false;
    switch (message.type) {
      case "stream_event":
        return this.applyEvent(message.event);
      case "assistant": {
        // The complete message follows its stream; it carries the tool input in one piece.
        let changed = false;
        for (const block of message.message.content) {
          const step = block.type === "tool_use" ? this.steps.get(block.id) : undefined;
          if (block.type === "tool_use" && step) {
            Object.assign(step, describeInput(block.name, block.input));
            changed = true;
          }
        }
        return changed;
      }
      case "user": {
        if (typeof message.message.content === "string") return false;
        let changed = false;
        for (const block of message.message.content) {
          const step = block.type === "tool_result" ? this.steps.get(block.tool_use_id) : undefined;
          if (block.type !== "tool_result" || !step) continue;
          step.status = block.is_error ? "failed" : "done";
          step.completedAt = Date.now();
          step.title = toolStyle(this.toolNames.get(block.tool_use_id)).done;
          changed = true;
        }
        return changed;
      }
      case "result": {
        const usage = message.usage;
        if (!usage) return false;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        this.usage = {
          input: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + cacheRead,
          cachedInput: cacheRead,
          output: usage.output_tokens,
          reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
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

  private applyEvent(event: StreamEvent): boolean {
    const now = Date.now();
    switch (event.type) {
      case "message_start":
        this.messageId = event.message.id;
        this.blocks.clear();
        return false;

      case "content_block_start": {
        const block = event.content_block;
        const key = block.type === "tool_use" ? block.id : `${this.messageId}:${event.index}`;
        this.blocks.set(event.index, { type: block.type, key });
        if (block.type === "text") {
          this.texts.set(key, block.text);
          return Boolean(block.text);
        }
        if (block.type === "thinking") {
          this.steps.set(key, { id: key, kind: "thinking", title: "Thinking", status: "running", startedAt: now });
          return true;
        }
        if (block.type === "tool_use") {
          const style = toolStyle(block.name);
          this.toolNames.set(key, block.name);
          this.steps.set(key, { id: key, kind: style.kind, title: style.running, status: "running", startedAt: now });
          return true;
        }
        return false;
      }

      case "content_block_delta": {
        const block = this.blocks.get(event.index);
        if (!block) return false;
        if (event.delta.type === "text_delta" && block.type === "text") {
          this.texts.set(block.key, (this.texts.get(block.key) ?? "") + event.delta.text);
          return true;
        }
        if (event.delta.type === "thinking_delta" && block.type === "thinking") {
          const text = (this.reasoning.get(block.key) ?? "") + event.delta.thinking;
          this.reasoning.set(block.key, text);
          const step = this.steps.get(block.key);
          const detail = reasoningDetail(text);
          if (step && detail && detail !== step.detail) {
            step.detail = detail;
            return true;
          }
        }
        return false;
      }

      case "content_block_stop": {
        const block = this.blocks.get(event.index);
        const step = block?.type === "thinking" ? this.steps.get(block.key) : undefined;
        if (!step) return false;
        // Tool steps stay running until their result arrives; reasoning is over once its block ends.
        step.status = "done";
        step.completedAt = now;
        step.title = "Thought";
        return true;
      }

      default:
        return false;
    }
  }
}

function toolStyle(name: string | undefined): ToolStyle {
  if (name && TOOL_STYLES[name]) return TOOL_STYLES[name];
  const label = name ? name.replace(/^mcp__/, "").replace(/[_-]+/g, " ") : "a tool";
  return { kind: "tool", running: `Using ${label}`, done: `Used ${label}` };
}

function describeInput(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): Pick<AgentStep, "detail" | "url"> {
  const string = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : undefined);
  switch (name) {
    case "WebSearch":
      return { detail: string("query") };
    case "WebFetch": {
      const url = string("url");
      return { detail: hostname(url), url };
    }
    case "Bash":
      return { detail: string("description") ?? string("command") };
    default:
      return { detail: string("description") ?? string("file_path") };
  }
}

/**
 * Claude summarizes its reasoning in prose ("I'm comparing the neighborhoods, …"). The first sentence of the
 * latest paragraph says what it's doing right now.
 */
function reasoningDetail(text: string): string | undefined {
  const paragraph = text
    .trim()
    .split(/\n\s*\n/)
    .at(-1)
    ?.trim();
  const sentence = paragraph?.match(/^.+?[.!?](?=\s|$)/s)?.[0] ?? paragraph;
  return sentence?.replace(/\s+/g, " ") || undefined;
}

function hostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
