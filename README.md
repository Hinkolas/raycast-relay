# Agent Proxy

Quick AI answers and chats inside Raycast, powered by the coding agent you already have installed. No API keys and no Raycast AI subscription: requests go through your local agent CLI and use its existing sign-in (for example your ChatGPT plan with Codex).

Providers:

- **Codex CLI**: available now
- Claude Code, OpenCode: coming soon

## Commands

| Command          | What it does                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask Question** | One question, one answer, no chat to manage. Press <kbd>↵</kbd> on the answer to **Continue in Chat** when you have a follow-up.                         |
| **Quick Chat**   | A classic chat. The search bar is the message box, each exchange is a list item and the detail pane shows the answer. Earlier chats are in the dropdown. |

### Use Ask Question as a fallback command

1. Open Raycast Settings → Extensions, select **Ask Question** and assign it as a **Fallback Command** (or right-click it in the root search → _Manage Fallback Commands_).
2. Type any question into Raycast's root search, then pick **Ask Question** from the fallbacks.

### Shortcuts

| Action            | Shortcut         |
| ----------------- | ---------------- |
| Send / Continue   | <kbd>↵</kbd>     |
| Copy Answer       | <kbd>⌘ ⇧ C</kbd> |
| Paste Answer      | <kbd>⌘ ⇧ V</kbd> |
| Stop Answering    | <kbd>⌃ C</kbd>   |
| Regenerate Answer | <kbd>⌘ R</kbd>   |
| New Chat          | <kbd>⌘ N</kbd>   |
| Change Model      | <kbd>⌘ ⇧ M</kbd> |
| Delete Chat       | <kbd>⌃ D</kbd>   |

## Setup

1. Install the Codex CLI (`npm install -g @openai/codex` or `brew install codex`).
2. Sign in once in your terminal: `codex login`.
3. Run **Ask Question** or **Quick Chat**.

The extension finds `codex` through your login shell's `PATH` and common install locations (Homebrew, npm, nvm, `~/.local/bin`, …). If it can't, set **Codex CLI Path** in the extension preferences.

## Preferences

- **Reasoning Effort**: lower is faster. _Model Default_ uses whatever the model prefers.
- **Web Search**: lets the agent search the web for current information.
- **Custom Instructions**: added to every conversation, e.g. "Answer in German".
- **Model**: pick one with **Change Model** (<kbd>⌘ ⇧ M</kbd>) in any answer. The choice is remembered.

## How it works

The extension starts `codex app-server`, the JSON-RPC interface the Codex IDE extension and T3 Code use, and streams answers from it. Chats run with:

- a chat-assistant system prompt instead of Codex's coding-agent prompt,
- a read-only sandbox with approvals disabled, in an empty working directory in the extension's support folder,
- **ephemeral threads**, so quick questions don't show up in your Codex session history.

Chat history is stored locally in Raycast. When you reopen an earlier chat, its transcript is handed to a fresh Codex thread.

## Development

```bash
npm install
npm run dev     # opens the extension in Raycast in development mode
npm run lint
npm run build
```

Provider code lives in `src/providers/` and doesn't depend on Raycast APIs. A new provider implements the `Provider` interface from `src/providers/types.ts` and is registered in `src/lib/settings.ts`.
