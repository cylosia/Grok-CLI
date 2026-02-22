import { useRef } from "react";
import { CommandPalette } from "./components/command-palette.js";
import { AgentSupervisor } from "../agent/supervisor.js";
import { loadRuntimeConfig } from "../utils/runtime-config.js";

const App = () => {
  const configRef = useRef(loadRuntimeConfig());
  const supervisorRef = useRef<AgentSupervisor | null>(null);
  if (!supervisorRef.current) {
    supervisorRef.current = new AgentSupervisor(configRef.current.grokApiKey);
  }

  return <CommandPalette supervisor={supervisorRef.current} onClose={() => {}} />;
};

export default App;
