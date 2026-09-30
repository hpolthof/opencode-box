/**
 * Token counts for one request, normalized to OpenAI semantics:
 * `promptTokens` includes cached input and `completionTokens` includes
 * reasoning (reasoning is billed as output). See `piUsageToTokenUsage` in
 * src/piai/chat.ts for how pi-ai's usage maps onto this.
 */
export interface TokenUsage {
  /** All input tokens, cached or not. */
  promptTokens: number;
  /** Visible output + reasoning tokens (reasoning is billed as output). */
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
