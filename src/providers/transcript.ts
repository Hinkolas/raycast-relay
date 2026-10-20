import type { HistoryTurn } from "./types";

/** Seeds a fresh session with a conversation that was started in an earlier session. */
export function formatTranscript(history: HistoryTurn[]): string {
  const turns = history.map((turn) => `<user>\n${turn.prompt}\n</user>\n<assistant>\n${turn.answer}\n</assistant>`);
  return [
    "This conversation is being continued from an earlier session. Here is the transcript so far; continue it naturally and don't mention that it was restored.",
    `<transcript>\n${turns.join("\n")}\n</transcript>`,
  ].join("\n\n");
}
