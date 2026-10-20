import { showToast, Toast } from "@raycast/api";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import { useMemo } from "react";
import { effortLabel } from "../lib/format";
import { getProvider, getSettings, type Settings } from "../lib/settings";
import type { ModelChoice } from "../lib/types";
import type { ModelInfo, Provider } from "../providers/types";

interface StoredModelSettings {
  model?: string;
  effort?: string;
  fast?: boolean;
}

export interface ModelSettings {
  settings: Settings;
  provider: Provider;
  models: ModelInfo[];
  /** The selected model, or the provider default when none is selected. */
  selectedModel: ModelInfo | undefined;
  /** Effective choice for the next message: unsupported options fall back to the model's defaults. */
  choice: ModelChoice;
  /** The reasoning effort picked by the user, if the selected model supports it. */
  effortOverride: string | undefined;
  setModel: (model: string | undefined) => void;
  setEffort: (effort: string | undefined) => void;
  setFast: (fast: boolean) => void;
}

/**
 * Model, reasoning effort and fast mode, chosen from the action panel and remembered across commands.
 * Cached state is read synchronously, so the very first question already uses the saved choice.
 */
export function useModelSettings(): ModelSettings {
  const settings = useMemo(getSettings, []);
  const provider = useMemo(() => getProvider(settings), [settings]);
  const [stored, setStored] = useCachedState<StoredModelSettings>(`model-settings:${provider.id}`, {});
  const { data } = useCachedPromise(() => provider.listModels(), [], {
    keepPreviousData: true,
    // Setup problems (Codex missing, signed out) are reported when sending; no need for a second toast.
    onError: () => undefined,
  });
  // Models cached by an older version of the extension lack newer fields; skip them until fresh data arrives.
  const models = (data ?? []).filter((model) => Array.isArray(model.reasoningEfforts));

  const selectedModel = models.find((model) => (stored.model ? model.id === stored.model : model.isDefault));
  const effortSupported =
    !selectedModel || selectedModel.reasoningEfforts.some((option) => option.id === stored.effort);
  const effortOverride = effortSupported ? stored.effort : undefined;
  const choice: ModelChoice = {
    model: stored.model,
    modelName: selectedModel?.name,
    // Always send an explicit effort, so switching back to "default" also resets a live thread.
    effort: effortOverride ?? selectedModel?.defaultReasoningEffort,
    fast: Boolean(stored.fast && (selectedModel?.fastMode ?? !selectedModel)),
  };

  return {
    settings,
    provider,
    models,
    selectedModel,
    choice,
    effortOverride,
    setModel: (model) => setStored((current) => ({ ...current, model })),
    setEffort: (effort) => {
      setStored((current) => ({ ...current, effort }));
      showToast({
        style: Toast.Style.Success,
        title: `Reasoning: ${effort ? effortLabel(effort) : "Model Default"}`,
      });
    },
    setFast: (fast) => {
      setStored((current) => ({ ...current, fast }));
      showToast({
        style: Toast.Style.Success,
        title: fast ? "Fast mode on" : "Fast mode off",
        message: fast ? selectedModel?.fastMode?.description : undefined,
      });
    },
  };
}
