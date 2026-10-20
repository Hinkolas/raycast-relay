/**
 * The subset of the OpenCode v2 HTTP API (`opencode serve`, `GET /openapi.json`) that Relay uses.
 * Events aren't part of the OpenAPI document; their shapes were taken from the event stream.
 */

export interface ModelRef {
  /** Model id within its provider, e.g. "glm-5.3". */
  id: string;
  providerID: string;
  /** A model variant, usually a reasoning effort such as "high". */
  variant?: string;
}

export interface Location {
  directory: string;
}

export interface Model {
  id: string;
  providerID: string;
  name: string;
  family?: string;
  variants: { id: string }[];
  status: "alpha" | "beta" | "deprecated" | "active";
  enabled: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface Session {
  id: string;
  parentID?: string;
  title?: string;
  time: { created: number; updated: number };
  location?: Location;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface StructuredError {
  type: string;
  message: string;
  status?: number;
}

export interface FormOption {
  value: string;
  label: string;
}

export interface Form {
  id: string;
  sessionID: string;
  title: string;
  metadata?: { kind?: string };
  fields: { key: string; options?: FormOption[] }[];
}

interface SessionEvent<Type extends string, Data> {
  id?: string;
  type: Type;
  data: Data & { sessionID: string };
}

interface MessagePart {
  assistantMessageID: string;
  ordinal: number;
}

interface ToolPart {
  assistantMessageID: string;
  /** The tool call id. */
  id: string;
}

export type ServerEvent =
  | { id?: string; type: "server.connected"; data: Record<string, never> }
  | SessionEvent<"session.step.started", { assistantMessageID: string }>
  | SessionEvent<"session.step.ended", { assistantMessageID: string; finish?: string; tokens?: TokenUsage }>
  | SessionEvent<"session.text.started", MessagePart>
  | SessionEvent<"session.text.delta", MessagePart & { delta: string }>
  | SessionEvent<"session.text.ended", MessagePart & { text: string }>
  | SessionEvent<"session.reasoning.started", MessagePart>
  | SessionEvent<"session.reasoning.delta", MessagePart & { delta: string }>
  | SessionEvent<"session.reasoning.ended", MessagePart & { text: string }>
  | SessionEvent<"session.tool.input.started", ToolPart & { name: string }>
  | SessionEvent<"session.tool.called", ToolPart & { input?: Record<string, unknown> }>
  | SessionEvent<"session.tool.success", ToolPart>
  | SessionEvent<"session.tool.failed", ToolPart & { error?: StructuredError }>
  | SessionEvent<"session.error", { error?: StructuredError }>
  | SessionEvent<"session.execution.started", object>
  | SessionEvent<"session.execution.succeeded", object>
  | SessionEvent<"session.execution.interrupted", object>
  | SessionEvent<"session.execution.failed", { error?: StructuredError }>
  | { id?: string; type: "form.created"; data: { form: Form } }
  | { id?: string; type: "permission.asked"; data: { id: string; sessionID: string } }
  | { id?: string; type: "other"; data: { sessionID?: string } };

/** The session an event belongs to, if any. */
export function eventSessionId(event: ServerEvent): string | undefined {
  if (event.type === "form.created") return event.data.form.sessionID;
  return "sessionID" in event.data ? event.data.sessionID : undefined;
}
