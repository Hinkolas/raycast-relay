import { Color, Detail, Icon, List, open, type Image } from "@raycast/api";
import { collectSources, effortLabel, formatDuration, formatTokens, limitLabel, type Source } from "../lib/format";
import type { Exchange } from "../lib/types";

type Tag = { text: string; color?: Color; icon?: Image.ImageLike; url?: string };
type Row =
  | { type: "tags"; title: string; tags: Tag[] }
  | { type: "label"; title: string; text: string; color?: Color; icon?: Image.ImageLike }
  | { type: "separator" };

/**
 * A summary of an answer rather than a log: the model it came from, every page behind it, and one line of stats.
 * What the agent did step by step is shown in the answer itself while it works.
 */
function summaryRows(exchange: Exchange, providerName: string): Row[] {
  // "GPT-6.1-Sol · High · Fast", with a bolt in front when fast mode was on.
  const { choice } = exchange;
  const model = [
    choice?.modelName ?? choice?.model ?? `${providerName} Default`,
    choice?.effort ? effortLabel(choice.effort) : undefined,
    choice?.fast ? "Fast" : undefined,
  ];
  const rows: Row[] = [
    {
      type: "label",
      title: "Model",
      text: model.filter(Boolean).join(" · "),
      icon: choice?.fast ? { source: Icon.Bolt, tintColor: Color.Yellow } : undefined,
    },
  ];

  // One row of clickable chips: Raycast gives every link row its own caption line, which spreads a list apart.
  const sources = collectSources(exchange);
  if (sources.length > 0) {
    const tags = sources.map((source) => ({ text: sourceLabel(source), icon: Icon.Link, url: source.url }));
    rows.push({ type: "separator" }, { type: "tags", title: "Sources", tags });
  }

  const stats = statsRows(exchange);
  if (stats.length > 0) rows.push({ type: "separator" }, ...stats);
  return rows;
}

/** Short link texts like "Release" or "npm" say little without the site they point to. */
function sourceLabel(source: Source): string {
  // Pages that were only read, not cited, are already labeled by their URL.
  if (source.title.startsWith(source.domain)) return truncate(source.title, 32);
  return truncate(source.title.length < 12 ? `${source.title} · ${source.domain}` : source.title, 32);
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * "6.7s · 11.5k tokens", plus the plan's usage limit once it is worth noticing. Nothing while the answer is
 * still coming in.
 */
function statsRows(exchange: Exchange): Row[] {
  if (!exchange.completedAt) return [];
  const parts = [formatDuration(exchange.completedAt - exchange.createdAt)];
  if (exchange.usage) parts.push(`${formatTokens(exchange.usage.input + exchange.usage.output)} tokens`);
  const rows: Row[] = [{ type: "label", title: "Stats", text: parts.join(" · ") }];

  // The tightest limit is the one worth knowing about.
  const limit = exchange.limits?.toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
  const percent = Math.round(limit?.usedPercent ?? 0);
  if (limit && percent >= 50) {
    const color = percent >= 90 ? Color.Red : percent >= 70 ? Color.Orange : undefined;
    rows.push({ type: "label", title: limitLabel(limit), text: `${percent}% used`, color });
  }
  return rows;
}

export function DetailMetadata({ exchange, providerName }: { exchange: Exchange; providerName: string }) {
  return (
    <Detail.Metadata>
      {summaryRows(exchange, providerName).map((row, index) => {
        switch (row.type) {
          case "tags":
            return (
              <Detail.Metadata.TagList key={index} title={row.title}>
                {row.tags.map((tag, tagIndex) => (
                  <Detail.Metadata.TagList.Item
                    key={tagIndex}
                    text={tag.text}
                    color={tag.color}
                    icon={tag.icon}
                    onAction={tag.url ? () => open(tag.url!) : undefined}
                  />
                ))}
              </Detail.Metadata.TagList>
            );
          case "label":
            return (
              <Detail.Metadata.Label
                key={index}
                title={row.title}
                text={row.color ? { value: row.text, color: row.color } : row.text}
                icon={row.icon}
              />
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
      {summaryRows(exchange, providerName).map((row, index) => {
        switch (row.type) {
          case "tags":
            return (
              <List.Item.Detail.Metadata.TagList key={index} title={row.title}>
                {row.tags.map((tag, tagIndex) => (
                  <List.Item.Detail.Metadata.TagList.Item
                    key={tagIndex}
                    text={tag.text}
                    color={tag.color}
                    icon={tag.icon}
                    onAction={tag.url ? () => open(tag.url!) : undefined}
                  />
                ))}
              </List.Item.Detail.Metadata.TagList>
            );
          case "label":
            return (
              <List.Item.Detail.Metadata.Label
                key={index}
                title={row.title}
                text={row.color ? { value: row.text, color: row.color } : row.text}
                icon={row.icon}
              />
            );
          case "separator":
            return <List.Item.Detail.Metadata.Separator key={index} />;
        }
      })}
    </List.Item.Detail.Metadata>
  );
}
