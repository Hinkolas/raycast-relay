import { showToast, Toast } from "@raycast/api";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import { useMemo } from "react";
import { effortLabel } from "../lib/format";
import { getProvider, getSettings, PROVIDERS, type Settings } from "../lib/settings";
import type { ModelChoice } from "../lib/types";
import type { ModelInfo, Provider, ProviderId } from "../providers/types";

/** A provider picked from the action panel. It's dropped when the provider preference changes. */
interface StoredProviderChoice {
  id: ProviderId;
  preference: ProviderId;
}

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
  setProvider: (id: ProviderId) => void;
  setModel: (model: string | undefined) => void;
  setEffort: (effort: string | undefined) => void;
  setFast: (fast: boolean) => void;
}

/**
 * Provider, model, reasoning effort and fast mode, chosen from the action panel and remembered across commands.
 * Cached state is read synchronously, so the very first question already uses the saved choice.
 */
export function useModelSettings(): ModelSettings {
  const settings = useMemo(getSettings, []);
  const [providerChoice, setProviderChoice] = useCachedState<StoredProviderChoice | undefined>(
    "provider-choice",
    undefined,
  );
  const providerId = providerChoice?.preference === settings.providerId ? providerChoice.id : settings.providerId;
  const provider = useMemo(() => getProvider(providerId, settings), [providerId, settings]);
  const [stored, setStored] = useCachedState<StoredModelSettings>(`model-settings:${provider.id}`, {});
  const { data } = useCachedPromise((id: ProviderId) => getProvider(id, settings).listModels(), [providerId], {
    keepPreviousData: false,
    // Setup problems (agent missing, signed out) are reported when sending; no need for a second toast.
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
    setProvider: (id) => {
      setProviderChoice({ id, preference: settings.providerId });
      getProvider(id, settings).warmUp();
      showToast({
        style: Toast.Style.Success,
        title: `Provider: ${PROVIDERS.find((candidate) => candidate.id === id)?.name ?? id}`,
      });
    },
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
