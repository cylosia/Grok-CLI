import { useState } from "react";
import { logger } from "../../utils/logger.js";
import { Text, Box } from "ink";
import { useInput } from "ink";
import { AgentSupervisor } from "../../agent/supervisor.js";
import { parseTaskId } from "../../types/index.js";

interface CommandPaletteProps {
  supervisor: AgentSupervisor;
  onClose: () => void;
}

export const CommandPalette = ({ supervisor, onClose }: CommandPaletteProps) => {
  const [query, setQuery] = useState("");
  const [results] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || key.ctrl && input === "c") onClose();
    if (key.return && !isRunning) {
      setIsRunning(true);
      setError(null);
      const taskId = parseTaskId(`palette-${Date.now()}`);
      if (!taskId) {
        setError("Unable to create task id");
        setIsRunning(false);
        return;
      }

      supervisor.executeTask({ id: taskId, type: "reason", payload: { query }, priority: 10 })
        .then((result) => {
          if (result.success) {
            onClose();
            return;
          }

          setError(result.error || "Task failed");
        })
        .catch((taskError: unknown) => {
          setError(taskError instanceof Error ? taskError.message : String(taskError));
          logger.error("command-palette-task-failed", {
            component: "command-palette",
            error: taskError instanceof Error ? taskError.message : String(taskError),
          });
        })
        .finally(() => {
          setIsRunning(false);
        });
      return;
    }
    setQuery(prev => prev + input);
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
      <Text color="cyan">Grok CLI Command Palette (Ctrl+K)</Text>
      <Text color="white">{query || "Type a command..."}</Text>
      {results.map((r, i) => <Text key={i} color="green">{r}</Text>)}
      {isRunning ? <Text color="yellow">Running command…</Text> : null}
      {error ? <Text color="red">Error: {error}</Text> : null}
    </Box>
  );
};
