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
  const [initError] = useState<string | null>(() => {
    try {
      loadRuntimeConfig();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });
  const configRef = useRef(initError ? null : loadRuntimeConfig());
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
