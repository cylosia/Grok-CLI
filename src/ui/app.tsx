import React from "react";
import { CommandPalette } from "./components/command-palette.js";
import { AgentSupervisor } from "../agent/supervisor.js";

const apiKey = process.env.GROK_API_KEY;
if (!apiKey) {
  throw new Error("GROK_API_KEY is required");
}

const App = () => {
  const supervisor = new AgentSupervisor(apiKey);

  return <CommandPalette supervisor={supervisor} onClose={() => {}} />;
};

export default App;
