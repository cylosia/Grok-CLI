import React from "react";
import { render } from "ink";
import App from "./ui/app.js";
import { GrokAgent } from "./agent/grok-agent.js";

(async () => {
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

  // CLI Mode (MINGW64 / non-TTY safe)
  if (!process.stdout.isTTY || args.includes('--cli')) {
    const prompt = args.filter(a => !a.startsWith('--')).join(' ') || "Hello from Grok CLI";
    console.log("🖥️  CLI Mode (MINGW64 compatible)");
    console.log(`Prompt: ${prompt}`);

    const apiKey = process.env.GROK_API_KEY;
    if (!apiKey) {
      throw new Error("GROK_API_KEY is required");
    }
    const agent = new GrokAgent(apiKey);
    try {
      const result = await agent.processUserMessage(prompt);
      console.log("\nResult:");
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
    }
    process.exit(0);
  }

  // Full TUI (best experience in Windows Terminal / PowerShell)
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
  process.exit(0);
})();
