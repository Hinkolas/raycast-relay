import { Action, ActionPanel, Icon } from "@raycast/api";
import type { Chat } from "../hooks/useChat";

export function ModelSubmenu({ chat }: { chat: Chat }) {
  const defaultModel = chat.models.find((model) => model.isDefault);
  const defaultTitle = defaultModel ? `Default (${defaultModel.name})` : `${chat.provider.name} Default`;

  return (
    <ActionPanel.Submenu title="Change Model" icon={Icon.Stars} shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}>
      <Action
        title={defaultTitle}
        icon={chat.model === undefined ? Icon.Checkmark : Icon.Circle}
        onAction={() => chat.setModel(undefined)}
      />
      {chat.models.map((model) => (
        <Action
          key={model.id}
          title={model.name}
          icon={model.id === chat.model ? Icon.Checkmark : Icon.Circle}
          onAction={() => chat.setModel(model.id)}
        />
      ))}
    </ActionPanel.Submenu>
  );
}
