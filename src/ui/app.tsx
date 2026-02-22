import { useMemo, useState } from "react";
import { Text } from "ink";
import { CommandPalette } from "./components/command-palette.js";
import { AgentSupervisor } from "../agent/supervisor.js";
import { loadRuntimeConfig } from "../utils/runtime-config.js";
import { logger } from "../utils/logger.js";

const App = () => {
  const [configError] = useState<string | null>(() => {
    try {
      loadRuntimeConfig();
      return null;
    } catch (error) {
      logger.error("runtime-config-load-failed", {
        component: "app",
        error: error instanceof Error ? error.message : String(error),
      });
      return error instanceof Error ? error.message : String(error);
    }
  });

  const supervisor = useMemo(() => {
    try {
      const config = loadRuntimeConfig();
      return new AgentSupervisor(config.grokApiKey);
    } catch {
      return null;
    }
  }, []);

  if (configError || !supervisor) {
    return <Text color="red">Configuration error: {configError ?? "Failed to initialize supervisor"}</Text>;
  }

  return <CommandPalette supervisor={supervisor} onClose={() => {}} />;
};

export default App;
