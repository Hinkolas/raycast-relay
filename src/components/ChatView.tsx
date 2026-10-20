import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
  type Image,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect, useState } from "react";
import type { Chat } from "../hooks/useChat";
import { conversationMarkdown, exchangeMarkdown, firstLine } from "../lib/format";
import { deleteAllConversations, deleteConversation, loadConversations } from "../lib/storage";
import type { Exchange } from "../lib/types";
import { ModelSubmenu } from "./ModelSubmenu";

const NEW_CHAT = "new-chat";

/**
 * A classic chat inside a Raycast list: the search bar is the message composer, every exchange is a list item
 * (newest first), and the detail pane shows the selected answer.
 */
export function ChatView({ chat }: { chat: Chat }) {
  const { conversation } = chat;
  const [draft, setDraft] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const { data: savedConversations = [], revalidate } = useCachedPromise(loadConversations, [], {
    keepPreviousData: true,
  });

  useEffect(() => {
    if (chat.savedAt) revalidate();
  }, [chat.savedAt]);

  const exchanges = conversation.exchanges.toReversed();
  const newestId = exchanges[0]?.id;

  // Jump to the newest answer whenever a message is sent or another chat is opened.
  useEffect(() => {
    setSelectedId(newestId);
  }, [newestId, conversation.id]);

  const isSaved = savedConversations.some((saved) => saved.id === conversation.id);
  const hasMessages = exchanges.length > 0;
  const message = draft.trim();

  function send() {
    if (chat.isStreaming) {
      showToast({
        style: Toast.Style.Failure,
        title: "Still answering",
        message: "Stop the current answer with ⌃C first",
      });
      return;
    }
    chat.send(message);
    setDraft("");
  }

  async function deleteCurrent() {
    const confirmed = await confirmAlert({
      title: "Delete Chat?",
      message: `"${conversation.title}" will be removed from your history.`,
      icon: Icon.Trash,
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    await deleteConversation(conversation.id);
    chat.startNew();
    revalidate();
  }

  async function deleteAll() {
    const confirmed = await confirmAlert({
      title: "Delete All Chats?",
      message: "Your whole chat history will be removed. This can't be undone.",
      icon: Icon.Trash,
      primaryAction: { title: "Delete All", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    await deleteAllConversations();
    chat.startNew();
    revalidate();
  }

  function actions(exchange?: Exchange) {
    const isNewest = exchange?.id === newestId;
    return (
      <ActionPanel>
        <ActionPanel.Section>
          {message ? <Action title="Send Message" icon={Icon.ArrowRight} onAction={send} /> : null}
          {exchange?.answer ? (
            <Action.CopyToClipboard
              title="Copy Answer"
              content={exchange.answer}
              shortcut={Keyboard.Shortcut.Common.Copy}
            />
          ) : null}
          {exchange?.answer ? (
            <Action.Paste
              title="Paste Answer"
              content={exchange.answer}
              shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
            />
          ) : null}
          {chat.isStreaming ? (
            <Action
              title="Stop Answering"
              icon={Icon.Stop}
              shortcut={{ modifiers: ["ctrl"], key: "c" }}
              onAction={chat.stop}
            />
          ) : null}
          {exchange && isNewest && !chat.isStreaming ? (
            <Action
              title={exchange.status === "error" ? "Try Again" : "Regenerate Answer"}
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => chat.retry(exchange.id)}
            />
          ) : null}
          {exchange ? (
            <Action.CopyToClipboard
              title="Copy Question"
              content={exchange.prompt}
              shortcut={Keyboard.Shortcut.Common.CopyName}
            />
          ) : null}
        </ActionPanel.Section>
        <ActionPanel.Section>
          {hasMessages ? (
            <Action
              title="New Chat"
              icon={Icon.Plus}
              shortcut={Keyboard.Shortcut.Common.New}
              onAction={chat.startNew}
            />
          ) : null}
          <ModelSubmenu chat={chat} />
          {hasMessages ? (
            <Action.CopyToClipboard
              title="Copy Chat"
              content={conversationMarkdown(conversation)}
              shortcut={{ modifiers: ["cmd", "shift", "opt"], key: "c" }}
            />
          ) : null}
        </ActionPanel.Section>
        <ActionPanel.Section>
          {isSaved ? (
            <Action
              title="Delete Chat"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.Remove}
              onAction={deleteCurrent}
            />
          ) : null}
          {savedConversations.length > 0 ? (
            <Action
              title="Delete All Chats"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.RemoveAll}
              onAction={deleteAll}
            />
          ) : null}
          <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel.Section>
      </ActionPanel>
    );
  }

  // The current chat is listed even before its first answer is saved, so "New Chat" can always be selected.
  const recentChats = isSaved || !hasMessages ? savedConversations : [conversation, ...savedConversations];
  const dropdownValue = hasMessages ? conversation.id : NEW_CHAT;

  const chatPicker = (
    <List.Dropdown
      tooltip="Chats"
      value={dropdownValue}
      onChange={(value) => {
        if (value === dropdownValue) return;
        if (value === NEW_CHAT) return chat.startNew();
        const target = savedConversations.find((saved) => saved.id === value);
        if (target) chat.open(target);
      }}
    >
      <List.Dropdown.Item title="New Chat" value={NEW_CHAT} icon={Icon.Plus} />
      {recentChats.length > 0 ? (
        <List.Dropdown.Section title="Recent Chats">
          {recentChats.map((recent) => (
            <List.Dropdown.Item key={recent.id} title={recent.title} value={recent.id} icon={Icon.Bubble} />
          ))}
        </List.Dropdown.Section>
      ) : null}
    </List.Dropdown>
  );

  return (
    <List
      navigationTitle={hasMessages ? conversation.title : "Quick Chat"}
      searchBarPlaceholder={hasMessages ? "Ask a follow-up…" : "Ask anything…"}
      searchText={draft}
      onSearchTextChange={setDraft}
      filtering={false}
      isLoading={chat.isStreaming}
      isShowingDetail={hasMessages}
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
      searchBarAccessory={chatPicker}
    >
      {hasMessages ? (
        exchanges.map((exchange) => (
          <List.Item
            key={exchange.id}
            id={exchange.id}
            title={firstLine(exchange.prompt)}
            icon={statusIcon(exchange)}
            detail={
              <List.Item.Detail
                markdown={exchangeMarkdown(exchange, exchange.status === "streaming" ? chat.activity : undefined)}
              />
            }
            actions={actions(exchange)}
          />
        ))
      ) : (
        <List.EmptyView
          icon={Icon.SpeechBubble}
          title={message ? "Press ↵ to Send" : "Start a Chat"}
          description={`Type your message in the search bar. Answers come from ${modelLabel(chat)}.`}
          actions={actions()}
        />
      )}
    </List>
  );
}

export function modelLabel(chat: Chat): string {
  const model = chat.models.find((candidate) => candidate.id === chat.model);
  return model ? `${chat.provider.name} (${model.name})` : chat.provider.name;
}

function statusIcon(exchange: Exchange): Image.ImageLike {
  switch (exchange.status) {
    case "streaming":
      return { source: Icon.CircleProgress50, tintColor: Color.Blue };
    case "error":
      return { source: Icon.Warning, tintColor: Color.Red };
    case "cancelled":
      return { source: Icon.Stop, tintColor: Color.SecondaryText };
    default:
      return Icon.Message;
  }
}
