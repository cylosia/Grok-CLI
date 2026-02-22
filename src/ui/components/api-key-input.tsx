import { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { GrokAgent } from "../../agent/grok-agent.js";
import { GrokClient } from "../../grok/client.js";
import { getSettingsManager } from "../../utils/settings-manager.js";
import { logger } from "../../utils/logger.js";

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
      handleSubmit().catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error));
        setIsSubmitting(false);
      });
      return;
    }


    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      setError("");
      return;
    }

    if (inputChar && !key.ctrl && !key.meta) {
      setInput((prev) => {
        if (prev.length >= 256) return prev; // API keys should not exceed 256 chars
        return prev + inputChar;
      });
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


      // Store API key in in-memory session state only (SettingsManager strips it from disk)
      try {
        const manager = getSettingsManager();
        await manager.updateUserSetting('apiKey', apiKey);
        logger.info("api-key-session-state-persisted", { component: "api-key-input" });
      } catch (_error) {
        logger.warn("api-key-session-state-persist-failed", { component: "api-key-input" });
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
