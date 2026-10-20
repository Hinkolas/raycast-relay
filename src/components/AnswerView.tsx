import { Action, ActionPanel, Detail, Icon, Keyboard, openExtensionPreferences } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";
import { exchangeMarkdown } from "../lib/format";
import { ChatView, modelLabel } from "./ChatView";
import { ModelSubmenu } from "./ModelSubmenu";

/**
 * Answers a single question in a full-width view. "Continue in Chat" turns the same conversation into a chat
 * in place, so a still-streaming answer simply keeps going there.
 */
export function AnswerView({ question, onAskAnother }: { question: string; onAskAnother: () => void }) {
  const chat = useChat();
  const [isChatting, setChatting] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    chat.send(question);
  }, []);

  if (isChatting) return <ChatView chat={chat} />;

  const exchange = chat.conversation.exchanges.at(-1);
  const answer = exchange?.answer;
  const failed = exchange?.status === "error";

  const continueInChat = (
    <Action
      title="Continue in Chat"
      icon={Icon.Bubble}
      onAction={() => {
        chat.persist();
        setChatting(true);
      }}
    />
  );
  const retry = exchange ? (
    <Action
      title={failed ? "Try Again" : "Regenerate Answer"}
      icon={Icon.ArrowClockwise}
      shortcut={Keyboard.Shortcut.Common.Refresh}
      onAction={() => chat.retry(exchange.id)}
    />
  ) : null;

  return (
    <Detail
      navigationTitle={`Ask ${modelLabel(chat)}`}
      isLoading={chat.isStreaming}
      markdown={exchange ? exchangeMarkdown(exchange, chat.activity) : ""}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            {failed && !chat.isStreaming ? retry : null}
            {continueInChat}
            {answer ? (
              <Action.CopyToClipboard title="Copy Answer" content={answer} shortcut={Keyboard.Shortcut.Common.Copy} />
            ) : null}
            {answer ? (
              <Action.Paste
                title="Paste Answer"
                content={answer}
                shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
              />
            ) : null}
          </ActionPanel.Section>
          <ActionPanel.Section>
            {chat.isStreaming ? (
              <Action
                title="Stop Answering"
                icon={Icon.Stop}
                shortcut={{ modifiers: ["ctrl"], key: "c" }}
                onAction={chat.stop}
              />
            ) : null}
            {!failed && !chat.isStreaming ? retry : null}
            <Action
              title="Ask Another Question"
              icon={Icon.QuestionMarkCircle}
              shortcut={Keyboard.Shortcut.Common.New}
              onAction={onAskAnother}
            />
            <ModelSubmenu chat={chat} />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
