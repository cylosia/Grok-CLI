import { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { getMCPManager } from "../../grok/tools.js";
import { logger } from "../../utils/logger.js";

export function MCPStatus() {
  const [connectedServers, setConnectedServers] = useState<string[]>([]);
  const lastWarnAtRef = useRef(0);

  useEffect(() => {
    const updateStatus = () => {
      try {
        const manager = getMCPManager();
        const servers = manager.getServers();
        setConnectedServers(servers);
      } catch (error: unknown) {
        const now = Date.now();
        if (now - lastWarnAtRef.current >= 10_000) {
          lastWarnAtRef.current = now;
          logger.warn("mcp-status-refresh-failed", {
            component: "mcp-status",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        setConnectedServers([]);
      }
    };

    // Initial update with a small delay to allow MCP initialization
    const initialTimer = setTimeout(updateStatus, 2000);

    // Set up polling to check for status changes
    const interval = setInterval(updateStatus, 2000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, []);

  if (connectedServers.length === 0) {
    return null;
  }

  return (
    <Box marginLeft={1}>
      <Text color="green">⚒ mcps: {connectedServers.length} </Text>
    </Box>
  );
}
