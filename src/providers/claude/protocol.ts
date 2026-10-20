/**
 * The subset of Claude Code's stream-json protocol (`claude -p --input-format stream-json --output-format
 * stream-json`) that Relay uses. It's the protocol the Claude Agent SDK speaks to the CLI: one JSON message per
 * line, user messages and control requests on stdin, conversation messages and control responses on stdout.
 */

export interface CliModel {
  /** Alias or full model name, e.g. "opus" or "claude-opus-4-8"; "default" follows the user's configuration. */
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

export interface InitializeResponse {
  models?: CliModel[];
}

/** Session settings Relay changes between turns. `null` falls back to the user's own configuration. */
export interface FlagSettings {
  model: string | null;
  effortLevel: string | null;
  fastMode: boolean | null;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "other" };

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
}

export type StreamEvent =
  | { type: "message_start"; message: { id: string; model?: string } }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string } | { type: "other" };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta" | "message_stop" };

/** Why an assistant message failed, e.g. "authentication_failed" or "rate_limit". */
export type AssistantError = string;

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  /** Usage windows by name, e.g. "five_hour" and "seven_day"; utilization is a fraction, reset times are seconds. */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

interface Envelope {
  /** Set when a subagent produced the message; Relay only follows the main conversation. */
  parent_tool_use_id?: string | null;
  session_id?: string;
}

export type OutputMessage =
  | ({ type: "stream_event"; event: StreamEvent } & Envelope)
  | ({ type: "assistant"; message: { id: string; content: ContentBlock[] }; error?: AssistantError } & Envelope)
  | ({ type: "user"; message: { content: string | (ToolResultBlock | { type: "other" })[] } } & Envelope)
  | ({
      type: "result";
      subtype: string;
      is_error: boolean;
      result?: string;
      usage?: Usage;
      terminal_reason?: string;
    } & Envelope)
  | ({ type: "rate_limit_event"; rate_limit_info: RateLimitInfo } & Envelope)
  | ({ type: "system"; subtype: string } & Envelope)
  | {
      type: "control_response";
      response: { subtype: "success" | "error"; request_id: string; response?: unknown; error?: string };
    }
  | { type: "control_request"; request_id: string; request: { subtype: string } };
