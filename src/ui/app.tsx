import React from "react";
import { CommandPalette } from "./components/command-palette.js";
import { AgentSupervisor } from "../agent/supervisor.js";

const App = () => {
  const supervisor = new AgentSupervisor(process.env.GROK_API_KEY!);

  return (
    <CommandPalette supervisor={supervisor} onClose={() => {}} />
  );
};

export default App;
