import { render } from "ink";
import App from "./ui/app.js";
import { GrokAgent } from "./agent/grok-agent.js";
import { loadRuntimeConfig } from "./utils/runtime-config.js";
import { getMCPManager } from "./grok/tools.js";
import { logger } from "./utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;

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
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("shutdown-signal-received", { component: "index", signal, exitCode });

    try {
      const manager = getMCPManager();
      const servers = manager.getServers();
      await Promise.race([
        Promise.allSettled(servers.map((server) => manager.removeServer(server))),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Shutdown cleanup timed out after ${SHUTDOWN_TIMEOUT_MS}ms`)), SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      logger.warn("shutdown-cleanup-failed", {
        component: "index",
        error: error instanceof Error ? error.message : String(error),
      });
      if (exitCode === 0) {
        exitCode = 1;
      }
    }

    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled-rejection", {
      component: "index",
      error: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown("UNHANDLED_REJECTION", 1);
  });

  process.on("uncaughtException", (error) => {
    logger.error("uncaught-exception", {
      component: "index",
      error: error instanceof Error ? error.message : String(error),
    });
    void shutdown("UNCAUGHT_EXCEPTION", 1);
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
