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
  return value as MCPServerName;
}

export function asToolCallId(value: string): ToolCallId {
  return value as ToolCallId;
}

export function asConfirmationRequestId(value: string): ConfirmationRequestId {
  return value as ConfirmationRequestId;
}
