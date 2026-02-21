import test from "node:test";
import assert from "node:assert/strict";
import { GrokClient } from "../src/grok/client.js";

interface StreamChunk {
  choices: Array<{ delta?: { tool_calls?: Array<{ index: number; id?: string; function?: { arguments?: string } }> } }>;
}

test("grok client rejects oversized streamed tool arguments", async () => {
  const client = new GrokClient("test-key");

  const internal = client as unknown as {
    client: {
      chat: {
        completions: {
          create: () => Promise<AsyncIterable<StreamChunk>>;
        };
      };
    };
  };

  internal.client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: "x".repeat(100_001),
                      },
                    },
                  ],
                },
              },
            ],
          };
        })(),
      },
    },
  };

  await assert.rejects(async () => {
    for await (const _chunk of client.chatStream([{ role: "user", content: "hi" }])) {
      // consume stream
    }
  }, /exceeded 100000 bytes/i);
});
