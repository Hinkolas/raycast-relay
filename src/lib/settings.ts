import { environment, getPreferenceValues } from "@raycast/api";
import { join } from "node:path";
import { ClaudeCodeProvider } from "../providers/claude";
import { CodexProvider } from "../providers/codex";
import { OpenCodeProvider } from "../providers/opencode";
import type { Provider, ProviderId } from "../providers/types";

export interface Settings {
  /** The provider from the preferences; it can be switched from the action panel. */
  providerId: ProviderId;
  codexPath?: string;
  opencodePath?: string;
  claudePath?: string;
  webSearch: boolean;
  customInstructions?: string;
}

export function getSettings(): Settings {
  const preferences = getPreferenceValues<Preferences>();
  return {
    providerId: preferences.provider ?? "codex",
    codexPath: preferences.codexPath?.trim() || undefined,
    opencodePath: preferences.opencodePath?.trim() || undefined,
    claudePath: preferences.claudePath?.trim() || undefined,
    webSearch: preferences.webSearch ?? true,
    customInstructions: preferences.customInstructions?.trim() || undefined,
  };
}

export const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "claude", name: "Claude Code" },
];

const providers = new Map<ProviderId, Provider>();

/**
 * Providers hold a running agent process or connection, so one instance per provider is shared by every view of a
 * command. Raycast restarts the command when preferences change, so the settings it was created with stay valid.
 */
export function getProvider(id: ProviderId, settings: Settings): Provider {
  let provider = providers.get(id);
  if (!provider) {
    const workingDirectory = join(environment.supportPath, "workspace");
    switch (id) {
      case "opencode":
        provider = new OpenCodeProvider({ binaryPath: settings.opencodePath, workingDirectory });
        break;
      case "claude":
        provider = new ClaudeCodeProvider({ binaryPath: settings.claudePath, workingDirectory });
        break;
      default:
        provider = new CodexProvider({ binaryPath: settings.codexPath, workingDirectory, clientVersion: "1.0.0" });
    }
    providers.set(id, provider);
  }
  return provider;
}

const BASE_INSTRUCTIONS = `You are a helpful, knowledgeable assistant living inside Raycast, the macOS launcher. People use you for quick questions and short conversations, like they would use ChatGPT or Claude.

- Be direct and concise. Lead with the answer, skip preamble and filler, and expand only when the question needs depth.
- Format with Markdown when it helps readability: short paragraphs, lists, tables, and fenced code blocks with a language tag.
- You are not working on a coding task or inside a project. Don't run shell commands or read files unless the user explicitly asks about something on their machine.
- When a question depends on recent or changing information, search the web if you can, and say so when you can't verify something.`;

export function buildInstructions(settings: Settings): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const sections = [BASE_INSTRUCTIONS, `Today is ${today}.`];
  if (settings.customInstructions) {
    sections.push(`Additional instructions from the user:\n${settings.customInstructions}`);
  }
  return sections.join("\n\n");
}
