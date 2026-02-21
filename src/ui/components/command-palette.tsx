import { useState } from "react";
import { Text, Box } from "ink";
import { useInput } from "ink";
import { AgentSupervisor } from "../../agent/supervisor.js";

interface CommandPaletteProps {
  supervisor: AgentSupervisor;
  onClose: () => void;
}

export const CommandPalette = ({ supervisor, onClose }: CommandPaletteProps) => {
  const [query, setQuery] = useState("");
  const [results] = useState<string[]>([]);

  useInput((input, key) => {
    if (key.escape || key.ctrl && input === "c") onClose();
    if (key.return) {
      void supervisor.executeTask({ id: "palette-" + Date.now(), type: "reason", payload: { query }, priority: 10 });
      onClose();
    }
    setQuery(prev => prev + input);
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
      <Text color="cyan">Grok CLI Command Palette (Ctrl+K)</Text>
      <Text color="white">{query || "Type a command..."}</Text>
      {results.map((r, i) => <Text key={i} color="green">{r}</Text>)}
    </Box>
  );
};
