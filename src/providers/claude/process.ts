import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { InitializeResponse, OutputMessage } from "./protocol";

export interface ClaudeProcessOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface PendingRequest {
  subtype: string;
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * One `claude -p` process in stream-json mode, which holds a single conversation. User messages and control
 * requests (interrupt, settings changes) go to stdin; the CLI exits on its own when stdin closes, so it never
 * outlives the Raycast command.
 */
export class ClaudeProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageListeners = new Set<(message: OutputMessage) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private nextId = 1;
  private stderrTail = "";
  private exitError: Error | undefined;

  private constructor(options: ClaudeProcessOptions) {
    this.child = spawn(options.binary, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
    this.child.stdin.on("error", () => undefined); // EPIPE after the process died; reported through "close".
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.terminate(error));
    this.child.on("close", (code, signal) => {
      const details = this.stderrTail.trim();
      this.terminate(
        new Error(`Claude Code exited (${signal ?? `code ${code}`})${details ? `: ${details.split("\n").pop()}` : ""}`),
      );
    });
  }

  static async start(options: ClaudeProcessOptions): Promise<{ process: ClaudeProcess; init: InitializeResponse }> {
    const claude = new ClaudeProcess(options);
    try {
      const init = await claude.request<InitializeResponse>("initialize");
      return { process: claude, init };
    } catch (error) {
      claude.close();
      throw error;
    }
  }

  get isAlive(): boolean {
    return this.exitError === undefined;
  }

  request<T>(subtype: string, params: object = {}): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const requestId = `relay-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { subtype, resolve: resolve as (response: unknown) => void, reject });
      this.write({ type: "control_request", request_id: requestId, request: { subtype, ...params } });
    });
  }

  sendUserMessage(text: string) {
    this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
  }

  onMessage(listener: (message: OutputMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close() {
    this.terminate(new Error("Claude Code process closed"));
    this.child.stdin.end();
    this.child.kill();
  }

  private write(message: object) {
    if (this.exitError) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    let message: OutputMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not a protocol message.
    }

    if (message.type === "control_response") {
      const { request_id, subtype, response, error } = message.response;
      const request = this.pending.get(request_id);
      if (!request) return;
      this.pending.delete(request_id);
      if (subtype === "error") request.reject(new Error(error || `Claude Code request "${request.subtype}" failed`));
      else request.resolve(response);
    } else if (message.type === "control_request") {
      this.handleCliRequest(message.request_id, message.request.subtype);
    } else {
      for (const listener of [...this.messageListeners]) listener(message);
    }
  }

  /** Chats only search the web and nothing prompts for permission, so anything the CLI asks of us is declined. */
  private handleCliRequest(requestId: string, subtype: string) {
    const response =
      subtype === "can_use_tool"
        ? { subtype: "success", request_id: requestId, response: { behavior: "deny", message: "Not available here" } }
        : { subtype: "error", request_id: requestId, error: `${subtype} is not supported by this client` };
    this.write({ type: "control_response", response });
  }

  private terminate(error: Error) {
    if (this.exitError) return;
    this.exitError = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of [...this.exitListeners]) listener(error);
    this.exitListeners.clear();
    this.messageListeners.clear();
  }
}
