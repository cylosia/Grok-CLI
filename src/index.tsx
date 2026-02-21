import { render } from "ink";
import App from "./ui/app.js";
import { GrokAgent } from "./agent/grok-agent.js";
import { loadRuntimeConfig } from "./utils/runtime-config.js";
import { getMCPManager } from "./grok/tools.js";
import { logger } from "./utils/logger.js";

void (async () => {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Grok CLI v2.0 – SuperAgent Terminal

Usage: grok [options] [prompt]

Options:
  --help, -h     Show this help
  --version      Show version
  --cli          Force CLI mode (MINGW64 safe)

Examples:
  grok "How many files are in this repo"
  grok --cli "Refactor the theme engine"

Full TUI launches automatically when TTY is detected.
`);
    process.exit(0);
  }

  if (args.includes('--version')) {
    console.log("v2.0.0");
    process.exit(0);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("shutdown-signal-received", { component: "index", signal });

    try {
      const manager = getMCPManager();
      const servers = manager.getServers();
      await Promise.allSettled(servers.map((server) => manager.removeServer(server)));
    } catch (error) {
      logger.warn("shutdown-cleanup-failed", {
        component: "index",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // CLI Mode (MINGW64 / non-TTY safe)
  if (!process.stdout.isTTY || args.includes('--cli')) {
    const prompt = args.filter(a => !a.startsWith('--')).join(' ') || "Hello from Grok CLI";
    logger.info("cli-mode", { component: "index", promptLength: prompt.length });

    const config = loadRuntimeConfig();
    const agent = new GrokAgent(config.grokApiKey, config.grokBaseUrl);
    try {
      const result = await agent.processUserMessage(prompt);
      console.log("\nResult:");
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      logger.error("cli-mode-error", {
        component: "index",
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
    process.exit(0);
  }

  // Full TUI (best experience in Windows Terminal / PowerShell)
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
  process.exit(0);
})();
