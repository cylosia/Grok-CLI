export type Brand<T, B extends string> = T & { readonly __brand: B };
export type TaskId = Brand<string, "TaskId">;
export type MCPServerName = Brand<string, "MCPServerName">;
export type MCPToolName = Brand<string, "MCPToolName">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type ConfirmationRequestId = Brand<string, "ConfirmationRequestId">;

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  data?: unknown;
}

export interface Tool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

export interface EditorCommand {
  command: 'view' | 'str_replace' | 'create' | 'insert' | 'undo_edit';
  path?: string;
  old_str?: string;
  new_str?: string;
  content?: string;
  insert_line?: number;
  view_range?: [number, number];
  replace_all?: boolean;
  previous_content?: string;
}

export interface AgentState {
  currentDirectory: string;
  editHistory: EditorCommand[];
  tools: Tool[];
}

export interface ConfirmationState {
  skipThisSession: boolean;
  pendingOperation: boolean;
}


export function asMCPServerName(value: string): MCPServerName {
  const parsed = parseMCPServerName(value);
  if (!parsed) {
    throw new Error(`Invalid MCP server name: ${value}`);
  }
  return parsed;
}

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseMCPServerName(value: string): MCPServerName | null {
  if (!MCP_SERVER_NAME_PATTERN.test(value) || RESERVED_KEYS.has(value)) {
    return null;
  }
  return value as MCPServerName;
}


const TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_:.\-]{1,256}$/;

export function asToolCallId(value: string): ToolCallId {
  if (!TOOL_CALL_ID_PATTERN.test(value)) {
    throw new Error(`Invalid tool call ID: ${value.slice(0, 64)}`);
  }
  return value as ToolCallId;
}

const CONFIRMATION_REQUEST_ID_PATTERN = /^[a-fA-F0-9]{1,256}$/;

export function asConfirmationRequestId(value: string): ConfirmationRequestId {
  if (!CONFIRMATION_REQUEST_ID_PATTERN.test(value)) {
    throw new Error(`Invalid confirmation request ID: ${value.slice(0, 64)}`);
  }
  return value as ConfirmationRequestId;
}


const TASK_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

export function parseTaskId(value: string): TaskId | null {
  if (!TASK_ID_PATTERN.test(value)) {
    return null;
  }
  return value as TaskId;
}
