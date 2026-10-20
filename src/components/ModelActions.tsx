import { Action, ActionPanel, Color, Icon } from "@raycast/api";
import type { ModelSettings } from "../hooks/useModelSettings";
import { effortLabel } from "../lib/format";
import { PROVIDERS } from "../lib/settings";
import type { ModelInfo } from "../providers/types";

const selected = (isSelected: boolean) => (isSelected ? Icon.Checkmark : Icon.Circle);

/** Models in the order the provider lists them, split into sections when they come from several sources. */
function groupModels(models: ModelInfo[]): { title?: string; models: ModelInfo[] }[] {
  const groups = new Map<string | undefined, ModelInfo[]>();
  for (const model of models) groups.set(model.group, [...(groups.get(model.group) ?? []), model]);
  return [...groups].map(([title, models]) => ({ title, models }));
}

/** Provider, model, reasoning effort and fast mode. The choice applies to the next message and is remembered. */
export function ModelActions({ modelSettings }: { modelSettings: ModelSettings }) {
  const { models, selectedModel, choice, effortOverride, provider } = modelSettings;
  const defaultModel = models.find((model) => model.isDefault);
  const efforts = selectedModel?.reasoningEfforts ?? [];

  return (
    <ActionPanel.Section title="Model">
      <ActionPanel.Submenu
        title={`Provider: ${provider.name}`}
        icon={Icon.Plug}
        shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
      >
        {PROVIDERS.map((candidate) => (
          <Action
            key={candidate.id}
            title={candidate.name}
            icon={selected(candidate.id === provider.id)}
            onAction={() => modelSettings.setProvider(candidate.id)}
          />
        ))}
      </ActionPanel.Submenu>
      <ActionPanel.Submenu
        title={`Model: ${selectedModel?.name ?? choice.model ?? `${provider.name} Default`}`}
        icon={Icon.Stars}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
      >
        <Action
          title={defaultModel ? `Default (${defaultModel.name})` : `${provider.name} Default`}
          icon={selected(choice.model === undefined)}
          onAction={() => modelSettings.setModel(undefined)}
        />
        {groupModels(models).map((group) => (
          <ActionPanel.Section key={group.title ?? "models"} title={group.title}>
            {group.models.map((model) => (
              <Action
                key={model.id}
                title={model.name}
                icon={selected(model.id === choice.model)}
                onAction={() => modelSettings.setModel(model.id)}
              />
            ))}
          </ActionPanel.Section>
        ))}
      </ActionPanel.Submenu>
      {efforts.length > 0 ? (
        <ActionPanel.Submenu
          title={`Reasoning: ${choice.effort ? effortLabel(choice.effort) : "Default"}`}
          icon={Icon.LightBulb}
          shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
        >
          <Action
            title={
              selectedModel?.defaultReasoningEffort
                ? `Default (${effortLabel(selectedModel.defaultReasoningEffort)})`
                : "Default"
            }
            icon={selected(effortOverride === undefined)}
            onAction={() => modelSettings.setEffort(undefined)}
          />
          {efforts.map((effort) => (
            <Action
              key={effort.id}
              title={effortLabel(effort.id)}
              icon={selected(effort.id === effortOverride)}
              onAction={() => modelSettings.setEffort(effort.id)}
            />
          ))}
        </ActionPanel.Submenu>
      ) : null}
      {selectedModel?.fastMode ? (
        <Action
          title={choice.fast ? "Turn off Fast Mode" : "Turn on Fast Mode"}
          icon={choice.fast ? Icon.BoltDisabled : { source: Icon.Bolt, tintColor: Color.Yellow }}
          shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
          onAction={() => modelSettings.setFast(!choice.fast)}
        />
      ) : null}
    </ActionPanel.Section>
  );
}
