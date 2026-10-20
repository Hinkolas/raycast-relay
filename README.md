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

Both commands take an optional argument, so you can type `Ask Question ⇥ your question` or `Quick Chat ⇥ your message` straight from the root search.

### See what the agent is doing

While the agent works you see a live timeline: web searches with their queries, pages it reads, and reasoning steps titled by the model's own summary (e.g. _Comparing sources_). Once the answer arrives, the timeline collapses into one line like _Searched the web 2 times · Thought for 4s_.

The details sidebar of Ask Question (<kbd>⌘ I</kbd>) lists the model, reasoning effort and speed, every step with its duration, the sources the answer cites, token usage and how much of your plan's usage limit is left. In Quick Chat, <kbd>⌘ I</kbd> shows a compact version below each answer.

### Model controls

From the action panel (<kbd>⌘ K</kbd>), also before you ask:

- **Model** (<kbd>⌘ ⇧ M</kbd>): any model your Codex account offers.
- **Reasoning** (<kbd>⌘ ⇧ R</kbd>): the efforts the selected model supports, from Low to Ultra. Lower is faster.
- **Fast Mode** (<kbd>⌘ ⇧ F</kbd>): the model's faster service tier, when it has one (uses more of your plan's quota).

Your choice is remembered and applies to both commands.

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
| Reasoning Effort  | <kbd>⌘ ⇧ R</kbd> |
| Toggle Fast Mode  | <kbd>⌘ ⇧ F</kbd> |
| Show/Hide Details | <kbd>⌘ I</kbd>   |
| Delete Chat       | <kbd>⌃ D</kbd>   |

## Setup

1. Install the Codex CLI (`npm install -g @openai/codex` or `brew install codex`).
2. Sign in once in your terminal: `codex login`.
3. Run **Ask Question** or **Quick Chat**.

The extension finds `codex` through your login shell's `PATH` and common install locations (Homebrew, npm, nvm, `~/.local/bin`, …). If it can't, set **Codex CLI Path** in the extension preferences.

## Preferences

- **Web Search**: lets the agent search the web for current information.
- **Custom Instructions**: added to every conversation, e.g. "Answer in German".
- **Codex CLI Path**: only needed when `codex` isn't found automatically.

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
