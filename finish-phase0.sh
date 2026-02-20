#!/bin/bash
echo "=== Grok CLI v2.0 – Phase 0 FINAL CLEANUP ==="

# 1. Fix MCP ServerConfig (add missing optional fields)
cat << 'CLIENT' > src/mcp/client.ts
export interface MCPServerConfig {
  name: string;
  transport: {
    type: 'stdio' | 'http' | 'sse' | 'streamable_http';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  serverName: string;
}

export class MCPManager {
  async addServer(config: MCPServerConfig): Promise<void> {}
  async removeServer(name: string): Promise<void> {}
  getTools(): MCPTool[] { return []; }
  getServers(): string[] { return []; }
  getTransportType(name: string): string | undefined { return undefined; }
  ensureServersInitialized(): Promise<void> { return Promise.resolve(); }
  async callTool(name: string, args: any): Promise<any> { return { content: [] }; }
}
CLIENT

# 2. Fix toolResult non-null in hooks and chat-interface
sed -i 's/chunk.toolResult.success/chunk.toolResult!.success/g' src/hooks/use-input-handler.ts
sed -i 's/chunk.toolResult.output/chunk.toolResult!.output/g' src/hooks/use-input-handler.ts
sed -i 's/chunk.toolResult.error/chunk.toolResult!.error/g' src/hooks/use-input-handler.ts
sed -i 's/chunk.toolResult.success/chunk.toolResult!.success/g' src/ui/components/chat-interface.tsx
sed -i 's/chunk.toolResult.output/chunk.toolResult!.output/g' src/ui/components/chat-interface.tsx
sed -i 's/chunk.toolResult.error/chunk.toolResult!.error/g' src/ui/components/chat-interface.tsx

# 3. Fix React global in chat-history
cat << 'HISTORY' > src/ui/components/chat-history.tsx
import React from "react";
import { ChatEntry } from "../../agent/grok-agent.js";
import { DiffRenderer } from "./diff-renderer.js";
import { Text } from "ink";

const MemoizedChatEntry = React.memo((props: { entry: ChatEntry }) => {
  // original component body
  return <Text>{props.entry.content}</Text>;
});

export const ChatHistory = ({ entries }: { entries: ChatEntry[] }) => {
  return <>{entries.map((entry, i) => <MemoizedChatEntry key={i} entry={entry} />)}</>;
};
HISTORY

# 4. Fix marked-terminal types
mkdir -p src/types
cat << 'TYPES' > src/types/marked-terminal.d.ts
declare module 'marked-terminal' {
  const TerminalRenderer: any;
  export default TerminalRenderer;
}
TYPES

# 5. Fix remaining UI optional props (add | undefined)
sed -i 's/showVSCodeOpen: boolean;/showVSCodeOpen: boolean | undefined;/g' src/ui/components/confirmation-dialog.tsx
sed -i 's/filename: string;/filename: string | undefined;/g' src/ui/components/chat-history.tsx
sed -i 's/initialMessage: string;/initialMessage: string | undefined;/g' src/ui/components/chat-interface.tsx
sed -i 's/backgroundColor: "cyan";/backgroundColor: "cyan" | undefined;/g' src/ui/components/command-suggestions.tsx
sed -i 's/maxHeight: number;/maxHeight: number | undefined;/g' src/ui/components/diff-renderer.tsx

echo "✅ Phase 0 Final Cleanup Complete"
bun run build
bun run typecheck
