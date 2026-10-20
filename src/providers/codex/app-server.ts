import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { InitializeParams, ServerNotification } from "./protocol";

type RequestId = number | string;

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface IncomingMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface AppServerOptions {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientInfo: InitializeParams["clientInfo"];
}

/** Server-initiated approval requests we can answer with a plain "decline". */
const DECLINABLE_REQUESTS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

/**
 * A JSON-RPC connection to `codex app-server` over stdio (one JSON message per line).
 * The server exits on its own when stdin closes, so it never outlives the Raycast command.
 */
export class AppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: ServerNotification) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private nextId = 1;
  private stderrTail = "";
  private exitError: Error | undefined;

  private constructor(options: AppServerOptions) {
    this.child = spawn(options.binary, ["app-server"], { cwd: options.cwd, env: options.env, stdio: "pipe" });
    this.child.stdin.on("error", () => undefined); // EPIPE after the process died; reported through "exit".
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.terminate(error));
    this.child.on("close", (code, signal) => {
      const details = this.stderrTail.trim();
      this.terminate(
        new Error(
          `Codex app-server exited (${signal ?? `code ${code}`})${details ? `: ${details.split("\n").pop()}` : ""}`,
        ),
      );
    });
  }

  static async connect(options: AppServerOptions): Promise<AppServerConnection> {
    const connection = new AppServerConnection(options);
    try {
      const params: InitializeParams = {
        clientInfo: options.clientInfo,
        capabilities: { experimentalApi: false, requestAttestation: false },
      };
      await connection.request("initialize", params);
      connection.notify("initialized");
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  get isAlive(): boolean {
    return this.exitError === undefined;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close() {
    this.terminate(new Error("Codex app-server connection closed"));
    this.child.stdin.end();
    this.child.kill();
  }

  private write(message: object) {
    if (this.exitError) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    let message: IncomingMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not a protocol message.
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message.id, message.method);
    } else if (message.method) {
      const notification = { method: message.method, params: message.params } as ServerNotification;
      for (const listener of this.notificationListeners) listener(notification);
    } else if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message ?? `Codex request "${request.method}" failed`));
      } else {
        request.resolve(message.result);
      }
    }
  }

  /** Chats run read-only with approvals disabled, so anything the server asks of us is declined. */
  private handleServerRequest(id: RequestId, method: string) {
    if (DECLINABLE_REQUESTS.has(method)) {
      this.write({ id, result: { decision: "decline" } });
    } else {
      this.write({ id, error: { code: -32601, message: `${method} is not supported by this client` } });
    }
  }

  private terminate(error: Error) {
    if (this.exitError) return;
    this.exitError = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.exitListeners) listener(error);
    this.exitListeners.clear();
    this.notificationListeners.clear();
  }
}
