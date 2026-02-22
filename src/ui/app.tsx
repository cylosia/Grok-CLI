import { useMemo } from "react";
import { CommandPalette } from "./components/command-palette.js";
import { AgentSupervisor } from "../agent/supervisor.js";
import { loadRuntimeConfig } from "../utils/runtime-config.js";

const runtimeConfig = loadRuntimeConfig();

const App = () => {
  const supervisor = useMemo(() => new AgentSupervisor(runtimeConfig.grokApiKey), []);

  return <CommandPalette supervisor={supervisor} onClose={() => {}} />;
};

export default App;
