import type { AssistantMessageTokens } from "../opencode/types";

/**
 * Token counts for one request, normalized to OpenAI semantics.
 *
 * OpenCode reports every bucket separately - `total` is
 * `input + output + reasoning + cache.read + cache.write` - so its `output`
 * excludes reasoning tokens and its `input` excludes cached input. OpenAI's
 * `completion_tokens` / `output_tokens` include reasoning, and its
 * `prompt_tokens` / `input_tokens` include cached input, so passing
 * OpenCode's raw `input`/`output` through would silently drop reasoning
 * (and cache) from anything computed from them - most visibly, cost.
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

export function toTokenUsage(tokens: AssistantMessageTokens): TokenUsage {
  const reasoning = tokens.reasoning ?? 0;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  return {
    promptTokens: tokens.input + cacheRead + cacheWrite,
    completionTokens: tokens.output + reasoning,
    totalTokens: tokens.total,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
