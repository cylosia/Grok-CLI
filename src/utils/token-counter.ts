import { get_encoding, encoding_for_model, Tiktoken } from 'tiktoken';

export class TokenCounter {
  private encoder: Tiktoken;

  constructor(model?: string) {
    try {
      // Try to get encoding for specific model if recognized by tiktoken
      this.encoder = model
        ? encoding_for_model(model as Parameters<typeof encoding_for_model>[0])
        : get_encoding('cl100k_base');
    } catch {
      // Fallback to cl100k_base for unrecognized models (e.g. Grok models)
      this.encoder = get_encoding('cl100k_base');
    }
  }

  /**
   * Count tokens in a string
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return this.encoder.encode(text).length;
  }

  /**
   * Count tokens in messages array (for chat completions)
   */
  countMessageTokens(messages: Array<{ role: string; content: string | null; tool_calls?: unknown }>): number {
    let totalTokens = 0;
    
    for (const message of messages) {
      // Every message follows <|start|>{role/name}\n{content}<|end|\>\n
      totalTokens += 3; // Base tokens per message
      
      if (message.content && typeof message.content === 'string') {
        totalTokens += this.countTokens(message.content);
      }
      
      if (message.role) {
        totalTokens += this.countTokens(message.role);
      }
      
      // Add extra tokens for tool calls if present
      if (message.tool_calls) {
        totalTokens += this.countTokens(JSON.stringify(message.tool_calls));
      }
    }
    
    totalTokens += 3; // Every reply is primed with <|start|>assistant<|message|>
    
    return totalTokens;
  }

  /**
   * Estimate tokens for streaming content
   * This is an approximation since we don't have the full response yet
   */
  estimateStreamingTokens(accumulatedContent: string): number {
    return this.countTokens(accumulatedContent);
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.encoder.free();
  }
}

/**
 * Format token count for display (e.g., 1.2k for 1200)
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return "0";
  }

  if (count <= 999) {
    return Math.round(count).toString();
  }

  if (count < 1_000_000) {
    const k = count / 1000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }

  const m = count / 1_000_000;
  return m % 1 === 0 ? `${m}m` : `${m.toFixed(1)}m`;
}

/**
 * Create a token counter instance
 */
export function createTokenCounter(model?: string): TokenCounter {
  return new TokenCounter(model);
}
