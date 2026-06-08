/**
 * ProviderCall seam (E003 / ADR-0001, ADR-0004) — the pluggable model call the
 * native agent loop invokes. E003 ships a stub; E006 implements the real
 * DeepSeek/Minimax adapters against this exact contract. Pure types, no electron.
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on a `tool` message — the tool call it answers. */
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolUseRequest {
  toolName: string;
  toolInput: unknown;
  toolCallId: string;
}

/** Per-call token usage; the loop accumulates these into cumulative token-usage. */
export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ProviderRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ProviderTurn {
  text?: string;
  toolUses: ToolUseRequest[];
  usage: UsageDelta;
  /** True when the model has finished its turn (no further tool round-trips). */
  endOfTurn: boolean;
}

/** The model call. E003 = stub; E006 = real provider adapter. */
export type ProviderCall = (req: ProviderRequest) => Promise<ProviderTurn>;
