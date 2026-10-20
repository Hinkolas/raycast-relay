import type { AgentStep, StepKind, UsageLimit } from "../providers/types";
import type { Conversation, Exchange, ModelChoice } from "./types";

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** "GPT-6.1-Sol · Medium · Fast" */
export function choiceSummary(choice: ModelChoice | undefined, providerName: string): string {
  if (!choice) return providerName;
  return [
    choice.modelName ?? choice.model ?? providerName,
    choice.effort ? effortLabel(choice.effort) : undefined,
    choice.fast ? "Fast" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * An icon from `assets/` that renders inline with text in Raycast markdown. Raycast renders tinted images as
 * centered blocks, so the colors are baked into the assets: gray, "-active" blue for running steps, red for failed.
 */
function inlineIcon(name: string): string {
  return `![](${name}.png?raycast-width=14&raycast-height=14)`;
}

function stepIcon(kind: StepKind, status: AgentStep["status"] = "done"): string {
  if (status === "failed") return inlineIcon("step-failed");
  return inlineIcon(status === "running" ? `step-${kind}-active` : `step-${kind}`);
}

/**
 * The question as a heading, what the agent did, and the answer.
 * While nothing has been written yet, every step is listed live; afterwards they collapse into one line.
 */
export function exchangeMarkdown(exchange: Exchange): string {
  const parts = [questionMarkdown(exchange.prompt)];
  const steps = exchange.steps ?? [];
  const isStreaming = exchange.status === "streaming";

  if (isStreaming && !exchange.answer) {
    parts.push(timelineMarkdown(steps));
  } else {
    const summary = stepsSummary(steps.filter((step) => step.status !== "running"));
    if (summary) parts.push(`${stepIcon(summary.kind)} *${summary.text}*`);
  }

  if (exchange.answer) {
    const writing = isStreaming && !steps.some((step) => step.status === "running");
    parts.push(writing ? withCursor(exchange.answer) : exchange.answer);
  }

  if (isStreaming && exchange.answer) {
    const running = steps.find((step) => step.status === "running");
    if (running) parts.push(stepLine(running));
  }
  if (exchange.status === "cancelled") parts.push(`${inlineIcon("step-stopped")} *Stopped*`);
  if (exchange.status === "error")
    parts.push(`${inlineIcon("step-failed")} ${exchange.error ?? "**Something went wrong**"}`);
  return parts.join("\n\n");
}

function questionMarkdown(prompt: string): string {
  const text = prompt.trim();
  if (!text.includes("\n") && text.length <= 160) return `### ${text.replace(/^#+\s*/, "")}`;
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function timelineMarkdown(steps: AgentStep[]): string {
  const visible = visibleSteps(steps);
  if (visible.length === 0) return `${stepIcon("thinking", "running")} **Thinking…**`;
  // Hard line breaks keep the steps together as one compact block.
  return visible.slice(-8).map(stepLine).join("  \n");
}

/** Drops brief reasoning without a summary; it says nothing beyond "Thought". */
export function visibleSteps(steps: AgentStep[]): AgentStep[] {
  return steps.filter(
    (step) =>
      step.kind !== "thinking" ||
      step.status === "running" ||
      !["Thought", "Thinking"].includes(step.title) ||
      (step.completedAt ?? step.startedAt) - step.startedAt >= 1000,
  );
}

function stepLine(step: AgentStep): string {
  const title = step.status === "running" ? `**${step.title}…**` : step.title;
  const detail = step.detail ? ` · *${escapeInline(truncate(step.detail, 90))}*` : "";
  return `${stepIcon(step.kind, step.status)} ${title}${detail}`;
}

/** "Searched the web 2 times · Thought for 4s", led by the kind of the first part. */
export function stepsSummary(steps: AgentStep[]): { kind: StepKind; text: string } | undefined {
  const count = (kind: StepKind) => steps.filter((step) => step.kind === kind).length;
  const thinkingMs = steps
    .filter((step) => step.kind === "thinking")
    .reduce((total, step) => total + ((step.completedAt ?? step.startedAt) - step.startedAt), 0);

  const parts: { kind: StepKind; text: string }[] = [];
  const searches = count("search");
  if (searches) {
    parts.push({ kind: "search", text: searches === 1 ? "Searched the web" : `Searched the web ${searches} times` });
  }
  const pages = count("browse");
  if (pages) parts.push({ kind: "browse", text: `Read ${plural(pages, "page")}` });
  if (thinkingMs >= 1000) parts.push({ kind: "thinking", text: `Thought for ${formatDuration(thinkingMs)}` });
  const commands = count("command");
  if (commands) parts.push({ kind: "command", text: `Ran ${plural(commands, "command")}` });
  const tools = count("tool");
  if (tools) parts.push({ kind: "tool", text: `Used ${plural(tools, "tool")}` });
  if (count("edit")) parts.push({ kind: "edit", text: "Edited files" });

  if (parts.length === 0) return undefined;
  return { kind: parts[0].kind, text: parts.map((part) => part.text).join(" · ") };
}

export interface Source {
  title: string;
  url: string;
  domain: string;
}

/** Links the answer cites, deduplicated by URL. */
export function extractSources(markdown: string): Source[] {
  const sources = new Map<string, Source>();
  for (const match of markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = match[2];
    const key = url.replace(/#.*$/, "");
    if (sources.has(key)) continue;
    try {
      const domain = new URL(url).hostname.replace(/^www\./, "");
      sources.set(key, { title: match[1].replace(/[*_`]/g, ""), url, domain });
    } catch {
      // Not a valid URL.
    }
  }
  return [...sources.values()];
}

/** The whole conversation as Markdown, for copying. */
export function conversationMarkdown(conversation: Conversation): string {
  return conversation.exchanges
    .filter((exchange) => exchange.answer)
    .map((exchange) => `### ${exchange.prompt.trim()}\n\n${exchange.answer}`)
    .join("\n\n---\n\n");
}

export function firstLine(text: string): string {
  return text.trim().split("\n")[0];
}

export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function limitLabel(limit: UsageLimit): string {
  const minutes = limit.windowMinutes;
  if (minutes === 10080) return "Weekly Limit";
  if (minutes === 1440) return "Daily Limit";
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-Hour Limit`;
  return "Usage Limit";
}

function withCursor(text: string): string {
  // A cursor after a table row would break the table while it streams.
  return text.trimEnd().split("\n").at(-1)?.trimStart().startsWith("|") ? text : `${text} ▍`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function truncate(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

function escapeInline(text: string): string {
  return text.replace(/([*_`[\]])/g, "\\$1");
}
