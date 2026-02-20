import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";
import { AgentSupervisor } from "../agent/supervisor.js";

interface VoiceInputProps {
  supervisor: AgentSupervisor;
}

export const VoiceInput = ({ supervisor }: VoiceInputProps) => {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");

  useEffect(() => {
    console.log("🎤 Voice Mode activated – speak now");
  }, []);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" padding={1}>
      <Text color="cyan">🎤 Voice Mode (Phase 2)</Text>
      <Text color={listening ? "green" : "yellow"}>{listening ? "🎙️ Listening..." : "Ready"}</Text>
      <Text color="white">{transcript || "Speak to Grok..."}</Text>
    </Box>
  );
};
