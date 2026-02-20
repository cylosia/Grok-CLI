import { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { GrokAgent } from "../../agent/grok-agent.js";
import { GrokClient } from "../../grok/client.js";
import { getSettingsManager } from "../../utils/settings-manager.js";

interface ApiKeyInputProps {
  onApiKeySet: (agent: GrokAgent) => void;
}

export default function ApiKeyInput({ onApiKeySet }: ApiKeyInputProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { exit } = useApp();

  useInput((inputChar, key) => {
    if (isSubmitting) return;

    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }

    if (key.return) {
      handleSubmit();
      return;
    }


    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      setError("");
      return;
    }

    if (inputChar && !key.ctrl && !key.meta) {
      setInput((prev) => prev + inputChar);
      setError("");
    }
  });


  const handleSubmit = async () => {
    if (!input.trim()) {
      setError("API key cannot be empty");
      return;
    }

    setIsSubmitting(true);
    try {
      const apiKey = input.trim();
      const probeClient = new GrokClient(apiKey);
      await probeClient.listModels();
      const agent = new GrokAgent(apiKey);


      // Persist non-sensitive settings; API key remains in memory for this session
      try {
        const manager = getSettingsManager();
        manager.updateUserSetting('apiKey', apiKey);
        console.log(`\n✅ API key validated and loaded for this session`);
      } catch (_error) {
        console.log('\n⚠️ Could not persist API key session state');
        console.log('API key set for current session only');
      }
      
      onApiKeySet(agent);
    } catch (error) {
      setError(error instanceof Error ? `API key validation failed: ${error.message}` : "API key validation failed");
      setIsSubmitting(false);
    }
  };

  const displayText = input.length > 0 ? 
    (isSubmitting ? "*".repeat(input.length) : "*".repeat(input.length) + "█") : 
    (isSubmitting ? " " : "█");

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color="yellow">🔑 Grok API Key Required</Text>
      <Box marginBottom={1}>
        <Text color="gray">Please enter your Grok API key to continue:</Text>
      </Box>
      
      <Box borderStyle="round" borderColor="blue" paddingX={1} marginBottom={1}>
        <Text color="gray">❯ </Text>
        <Text>{displayText}</Text>
      </Box>

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">❌ {error}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text color="gray" dimColor>• Press Enter to submit</Text>
        <Text color="gray" dimColor>• Press Ctrl+C to exit</Text>
        <Text color="gray" dimColor>Note: API key is scoped to this app session and not exported globally</Text>
      </Box>

      {isSubmitting ? (
        <Box marginTop={1}>
          <Text color="yellow">🔄 Validating API key...</Text>
        </Box>
      ) : null}
    </Box>
  );
}
