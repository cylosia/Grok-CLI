import test from "node:test";
import assert from "node:assert/strict";
import { GrokClient } from "../src/grok/client.js";
import { TEST_DUMMY_API_KEY } from "./test-constants.js";

interface StreamChunk {
  choices: Array<{ delta?: { tool_calls?: Array<{ index: number; id?: string; function?: { arguments?: string } }> } }>;
}

test("grok client rejects oversized streamed tool arguments", async () => {
  const client = new GrokClient(TEST_DUMMY_API_KEY);

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


test("grok client sets idempotency header on chat requests", async () => {
  const client = new GrokClient(TEST_DUMMY_API_KEY);
  let capturedHeaders: Record<string, string> | undefined;

  const internal = client as unknown as {
    client: {
      chat: {
        completions: {
          create: (_body: unknown, options?: { headers?: Record<string, string> }) => Promise<{ choices: Array<{ message: { content: string } }> }>;
        };
      };
    };
  };

  internal.client = {
    chat: {
      completions: {
        create: async (_body, options) => {
          capturedHeaders = options?.headers;
          return { choices: [{ message: { content: "ok" } }] };
        },
      },
    },
  };

  await client.chat([{ role: "user", content: "hello" }]);
  assert.equal(typeof capturedHeaders?.["Idempotency-Key"], "string");
  assert.ok((capturedHeaders?.["Idempotency-Key"]?.length ?? 0) > 0);
});
