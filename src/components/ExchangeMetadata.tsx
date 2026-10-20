import { Color, Detail, Icon, List, type Image } from "@raycast/api";
import { effortLabel, extractSources, formatDuration, formatTokens, limitLabel, visibleSteps } from "../lib/format";
import type { Exchange } from "../lib/types";
import type { AgentStep, StepKind } from "../providers/types";

type Row =
  | { type: "label"; title: string; text: string; icon?: Image.ImageLike; color?: Color }
  | { type: "link"; title: string; text: string; target: string }
  | { type: "tags"; title: string; tags: { text: string; color?: Color; icon?: Image.ImageLike }[] }
  | { type: "separator" };

const STEP_ICONS: Record<StepKind, Icon> = {
  thinking: Icon.LightBulb,
  search: Icon.MagnifyingGlass,
  browse: Icon.Document,
  command: Icon.Terminal,
  tool: Icon.Hammer,
  edit: Icon.Pencil,
};

/**
 * "full" is the sidebar of Ask Question: settings, every step, sources and stats.
 * "compact" sits below a chat answer, where vertical space is scarce.
 */
function metadataRows(exchange: Exchange, variant: "full" | "compact", providerName: string): Row[] {
  const rows: Row[] = [];
  const choice = exchange.choice;
  const modelName = choice?.modelName ?? choice?.model ?? `${providerName} Default`;

  if (variant === "full") {
    rows.push({ type: "label", title: "Model", text: modelName, icon: Icon.Stars });
    if (choice?.effort) {
      rows.push({ type: "label", title: "Reasoning", text: effortLabel(choice.effort), icon: Icon.LightBulb });
    }
    rows.push(
      choice?.fast
        ? { type: "label", title: "Speed", text: "Fast", icon: { source: Icon.Bolt, tintColor: Color.Yellow } }
        : { type: "label", title: "Speed", text: "Standard", icon: Icon.Gauge },
    );

    const steps = visibleSteps(exchange.steps ?? []).slice(-12);
    if (steps.length > 0) {
      rows.push({ type: "separator" });
      rows.push(...steps.map(stepRow));
    }
  } else {
    const tags: { text: string; color?: Color; icon?: Image.ImageLike }[] = [{ text: modelName, color: Color.Purple }];
    if (choice?.effort) tags.push({ text: effortLabel(choice.effort), color: Color.Blue });
    if (choice?.fast) tags.push({ text: "Fast", color: Color.Yellow, icon: Icon.Bolt });
    rows.push({ type: "tags", title: "Model", tags });
  }

  const sources = extractSources(exchange.answer).slice(0, variant === "full" ? 8 : 4);
  if (sources.length > 0) {
    rows.push({ type: "separator" });
    for (const source of sources) {
      rows.push({ type: "link", title: source.domain, text: truncate(source.title, 48), target: source.url });
    }
  }

  const stats: Row[] = [];
  if (exchange.completedAt) {
    stats.push({
      type: "label",
      title: "Duration",
      text: formatDuration(exchange.completedAt - exchange.createdAt),
      icon: Icon.Clock,
    });
  }
  if (variant === "full" && exchange.usage) {
    const { input, output } = exchange.usage;
    stats.push({
      type: "label",
      title: "Tokens",
      text: `${formatTokens(input)} in · ${formatTokens(output)} out`,
      icon: Icon.BarChart,
    });
  }
  if (variant === "full") {
    for (const limit of exchange.limits ?? []) {
      const percent = Math.round(limit.usedPercent);
      stats.push({
        type: "label",
        title: limitLabel(limit),
        text: `${percent}% used`,
        icon: Icon.Gauge,
        color: percent >= 90 ? Color.Red : percent >= 70 ? Color.Orange : undefined,
      });
    }
  }
  if (stats.length > 0) rows.push({ type: "separator" }, ...stats);

  return rows;
}

function stepRow(step: AgentStep): Row {
  const duration = step.completedAt ? step.completedAt - step.startedAt : 0;
  const titles: Record<StepKind, string> = {
    thinking: "Reasoning",
    search: "Web Search",
    browse: "Read Page",
    command: "Command",
    tool: "Tool",
    edit: "Files",
  };
  const title = duration >= 500 ? `${titles[step.kind]} · ${formatDuration(duration)}` : titles[step.kind];
  const text = step.kind === "thinking" || step.kind === "edit" ? step.title : (step.detail ?? step.title);
  const tintColor = step.status === "running" ? Color.Blue : step.status === "failed" ? Color.Red : undefined;
  return { type: "label", title, text: truncate(text, 60), icon: { source: STEP_ICONS[step.kind], tintColor } };
}

export function DetailMetadata({ exchange, providerName }: { exchange: Exchange; providerName: string }) {
  return (
    <Detail.Metadata>
      {metadataRows(exchange, "full", providerName).map((row, index) => {
        switch (row.type) {
          case "label":
            return (
              <Detail.Metadata.Label
                key={index}
                title={row.title}
                text={row.color ? { value: row.text, color: row.color } : row.text}
                icon={row.icon}
              />
            );
          case "link":
            return <Detail.Metadata.Link key={index} title={row.title} text={row.text} target={row.target} />;
          case "tags":
            return (
              <Detail.Metadata.TagList key={index} title={row.title}>
                {row.tags.map((tag) => (
                  <Detail.Metadata.TagList.Item key={tag.text} text={tag.text} color={tag.color} icon={tag.icon} />
                ))}
              </Detail.Metadata.TagList>
            );
          case "separator":
            return <Detail.Metadata.Separator key={index} />;
        }
      })}
    </Detail.Metadata>
  );
}

export function ListMetadata({ exchange, providerName }: { exchange: Exchange; providerName: string }) {
  return (
    <List.Item.Detail.Metadata>
      {metadataRows(exchange, "compact", providerName).map((row, index) => {
        switch (row.type) {
          case "label":
            return (
              <List.Item.Detail.Metadata.Label
                key={index}
                title={row.title}
                text={row.color ? { value: row.text, color: row.color } : row.text}
                icon={row.icon}
              />
            );
          case "link":
            return <List.Item.Detail.Metadata.Link key={index} title={row.title} text={row.text} target={row.target} />;
          case "tags":
            return (
              <List.Item.Detail.Metadata.TagList key={index} title={row.title}>
                {row.tags.map((tag) => (
                  <List.Item.Detail.Metadata.TagList.Item
                    key={tag.text}
                    text={tag.text}
                    color={tag.color}
                    icon={tag.icon}
                  />
                ))}
              </List.Item.Detail.Metadata.TagList>
            );
          case "separator":
            return <List.Item.Detail.Metadata.Separator key={index} />;
        }
      })}
    </List.Item.Detail.Metadata>
  );
}

function truncate(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
