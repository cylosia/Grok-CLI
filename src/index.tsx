import { render } from "ink";
import App from "./ui/app.js";
import { GrokAgent } from "./agent/grok-agent.js";
import { loadRuntimeConfig } from "./utils/runtime-config.js";
import { getMCPManager } from "./grok/tools.js";
import { logger, safeJsonStringify } from "./utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
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
    return;
  }

  if (args.includes('--version')) {
    console.log("v2.0.0");
    return;
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
    shutdown("SIGINT").catch((error: unknown) => {
      logger.error("shutdown-handler-failed", {
        component: "index",
        signal: "SIGINT",
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error: unknown) => {
      logger.error("shutdown-handler-failed", {
        component: "index",
        signal: "SIGTERM",
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : undefined;
    logger.error("unhandled-rejection", {
      component: "index",
      error: error ? error.message : String(reason),
      errorName: error?.name,
      ...(process.env.GROK_DEBUG_STACKS === "true" ? { errorStack: error?.stack } : {}),
    });
    shutdown("UNHANDLED_REJECTION", 1).catch((shutdownError: unknown) => {
      logger.error("shutdown-handler-failed", {
        component: "index",
        signal: "UNHANDLED_REJECTION",
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      });
      process.exit(1);
    });
  });

  process.on("uncaughtException", (error) => {
    logger.error("uncaught-exception", {
      component: "index",
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
      ...(process.env.GROK_DEBUG_STACKS === "true" ? { errorStack: error instanceof Error ? error.stack : undefined } : {}),
    });
    shutdown("UNCAUGHT_EXCEPTION", 1).catch((shutdownError: unknown) => {
      logger.error("shutdown-handler-failed", {
        component: "index",
        signal: "UNCAUGHT_EXCEPTION",
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      });
      process.exit(1);
    });
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
      console.log(safeJsonStringify(result));
    } catch (err) {
      logger.error("cli-mode-error", {
        component: "index",
        error: err instanceof Error ? err.message : String(err),
      });
      await shutdown("CLI_ERROR", 1);
      return;
    }
    await shutdown("CLI_COMPLETE", 0);
    return;
  }

  // Full TUI (best experience in Windows Terminal / PowerShell)
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
  await shutdown("TUI_COMPLETE", 0);
}

main().catch((error: unknown) => {
  logger.error("startup-failed", {
    component: "index",
    error: error instanceof Error ? error.message : String(error),
    ...(process.env.GROK_DEBUG_STACKS === "true" && error instanceof Error ? { errorStack: error.stack } : {}),
  });
  process.exit(1);
});
