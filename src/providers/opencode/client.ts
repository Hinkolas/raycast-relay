import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "./protocol";

export interface OpenCodeClientOptions {
  binary: string;
  env: NodeJS.ProcessEnv;
}

type Query = Record<string, string | undefined>;

/** An error response from the OpenCode server. */
export class OpenCodeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenCodeRequestError";
  }
}

/**
 * HTTP client for OpenCode's background service, the server its terminal UI, desktop app and `opencode run` share.
 * Using it means Relay sees exactly the providers, models, credentials and web search setup the user configured.
 * Events of all sessions arrive on one server-sent event stream, opened once per connection.
 */
export class OpenCodeClient {
  private readonly eventListeners = new Set<(event: ServerEvent) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly events = new AbortController();
  private closed = false;

  private constructor(
    private readonly baseUrl: string,
    private readonly authorization: string | undefined,
  ) {}

  /** Starts the background service if needed (`opencode service start` is idempotent) and subscribes to events. */
  static async connect(options: OpenCodeClientOptions): Promise<OpenCodeClient> {
    const baseUrl = await startService(options);
    const password = await readServicePassword(options.env);
    const authorization = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : undefined;
    const client = new OpenCodeClient(baseUrl, authorization);
    await client.subscribe();
    return client;
  }

  async request<T>(method: string, path: string, options: { body?: unknown; query?: Query } = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      headers: {
        ...(this.authorization ? { authorization: this.authorization } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new OpenCodeRequestError(errorMessage(text, response), response.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Called once when the event stream ends; the client can't be used afterwards. */
  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close() {
    this.events.abort();
    this.fail(new Error("OpenCode connection closed"));
  }

  private async subscribe() {
    const response = await fetch(new URL("/api/event", this.baseUrl), {
      headers: { accept: "text/event-stream", ...(this.authorization ? { authorization: this.authorization } : {}) },
      signal: this.events.signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeRequestError(errorMessage(await response.text(), response), response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resolveConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => (resolveConnected = resolve));

    const read = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const event = parseEvent(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (!event) continue;
            if (event.type === "server.connected") resolveConnected();
            for (const listener of [...this.eventListeners]) listener(event);
          }
        }
        this.fail(new Error("OpenCode closed the connection"));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void read();

    // The stream announces itself; prompts sent before that could miss their first events.
    await Promise.race([connected, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener(error);
    this.closeListeners.clear();
    this.eventListeners.clear();
  }
}

function parseEvent(block: string): ServerEvent | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return undefined;
  try {
    const event = JSON.parse(data) as ServerEvent;
    return typeof event?.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(body: string, response: Response): string {
  try {
    const json = JSON.parse(body);
    const message = json?.message ?? json?.error?.message ?? json?.data?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON.
  }
  return body.trim().slice(0, 200) || `${response.status} ${response.statusText}`;
}

/** Returns the service URL, e.g. "http://127.0.0.1:49374". */
function startService({ binary, env }: OpenCodeClientOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["service", "start"], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      const url = String(stdout)
        .match(/https?:\/\/[^\s"']+/g)
        ?.at(-1);
      if (url) resolve(url.replace(/\/$/, ""));
      else reject(new Error((String(stderr).trim() || error?.message) ?? "`opencode service start` printed no URL"));
    });
  });
}

/** The background service protects its API with a generated password, stored next to the user's config. */
async function readServicePassword(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  try {
    const { password } = JSON.parse(await readFile(join(configHome, "opencode", "service.json"), "utf8"));
    return typeof password === "string" && password ? password : undefined;
  } catch {
    return undefined;
  }
}
