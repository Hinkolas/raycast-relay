import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { ProviderError } from "../types";

export interface CodexInstallation {
  binary: string;
  /** Environment for the spawned process, with a PATH that also works for npm-installed (node) shims. */
  env: NodeJS.ProcessEnv;
}

const home = homedir();

/** Common install locations, checked in addition to the login shell's PATH. */
const FALLBACK_DIRS = [
  join(home, ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(home, ".npm-global/bin"),
  join(home, ".bun/bin"),
  join(home, ".volta/bin"),
  join(home, "Library/pnpm"),
  join(home, ".cargo/bin"),
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

let shellPath: Promise<string[]> | undefined;

/**
 * Raycast starts extensions with a minimal PATH, so tools installed through nvm, Homebrew, npm, … aren't
 * visible. Ask the user's login shell for its PATH once per process instead.
 */
function loginShellPath(): Promise<string[]> {
  shellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const marker = "__AGENT_PROXY_PATH__";
    execFile(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], { timeout: 5000 }, (_error, stdout) => {
      const match = String(stdout ?? "").match(new RegExp(`${marker}(.*?)${marker}`));
      resolve(match ? match[1].split(":").filter(Boolean) : []);
    });
  });
  return shellPath;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

export async function locateCodex(customPath?: string): Promise<CodexInstallation> {
  const searchDirs = [
    ...new Set([...(await loginShellPath()), ...(process.env.PATH?.split(delimiter) ?? []), ...FALLBACK_DIRS]),
  ];

  let binary: string | undefined;
  if (customPath?.trim()) {
    const candidate = expandHome(customPath.trim());
    if (!(await isExecutableFile(candidate))) {
      throw new ProviderError(
        `No Codex executable at ${candidate}`,
        "Fix the Codex CLI Path in the extension preferences, or clear it to detect Codex automatically.",
      );
    }
    binary = candidate;
  } else {
    for (const dir of searchDirs) {
      const candidate = join(dir, "codex");
      if (await isExecutableFile(candidate)) {
        binary = candidate;
        break;
      }
    }
  }

  if (!binary) {
    throw new ProviderError(
      "Codex CLI not found",
      "Install it with `npm install -g @openai/codex` or `brew install codex`, sign in with `codex login`, or set its path in the extension preferences.",
    );
  }

  const PATH = [...new Set([dirname(binary), ...searchDirs])].join(delimiter);
  return { binary, env: { ...process.env, PATH } };
}
