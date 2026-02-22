import React, { useRef, useState } from "react";
import { Text } from "ink";
import { CommandPalette } from "./components/command-palette.js";
import { AgentSupervisor } from "../agent/supervisor.js";
import { loadRuntimeConfig } from "../utils/runtime-config.js";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <Text color="red">Fatal error: {this.state.error.message}</Text>;
    }
    return this.props.children;
  }
}

const AppInner = () => {
  const [initResult] = useState<{ config: ReturnType<typeof loadRuntimeConfig> } | { error: string }>(() => {
    try {
      return { config: loadRuntimeConfig() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  const initError = "error" in initResult ? initResult.error : null;
  const configRef = useRef("error" in initResult ? null : initResult.config);
  const supervisorRef = useRef<AgentSupervisor | null>(null);
  if (configRef.current && !supervisorRef.current) {
    supervisorRef.current = new AgentSupervisor(configRef.current.grokApiKey);
  }

  if (initError || !supervisorRef.current) {
    return <Text color="red">Failed to initialize: {initError || "unknown error"}</Text>;
  }

  return <CommandPalette supervisor={supervisorRef.current} onClose={() => {}} />;
};

const App = () => (
  <ErrorBoundary>
    <AppInner />
  </ErrorBoundary>
);

export default App;
