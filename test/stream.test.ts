import { describe, expect, test } from "bun:test";
import { createOpenAIChatStream } from "../src/openai/stream";
import type { OpenCodeEvent } from "../src/opencode/types";

const SESSION_ID = "ses_test123";

async function readFrames(stream: ReadableStream<Uint8Array>): Promise<any[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const jsonStr = raw.slice("data: ".length);
      if (jsonStr === "[DONE]") continue;
      frames.push(JSON.parse(jsonStr));
    }
  }
  return frames;
}

describe("createOpenAIChatStream - structured output (json_schema format)", () => {
  // Regression test: OpenCode returns a json_schema result on
  // info.structured instead of as text parts - no message.part.updated
  // event ever fires for it, only the terminal message.updated. Without
  // special handling this streamed as an empty response.
  async function* structuredEvents(): AsyncGenerator<OpenCodeEvent> {
    yield {
      id: "evt1",
      type: "message.updated",
      properties: {
        sessionID: SESSION_ID,
        info: {
          id: "msg1",
          sessionID: SESSION_ID,
          role: "assistant",
          parentID: "",
          modelID: "gpt-5.4",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: { total: 15, input: 5, output: 10 },
          time: { created: 0, completed: 1 },
          structured: { greeting: "hallo" },
        },
      },
    } as OpenCodeEvent;
  }

  test("emits the structured result as a single stringified delta, then completes with it as fullText", async () => {
    const { stream, done, firstOutcome } = createOpenAIChatStream(structuredEvents(), SESSION_ID, "openai/gpt-5.4");
    const frames = await readFrames(stream);

    const deltas = frames.filter((f) => f.choices?.[0]?.delta?.content);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].choices[0].delta.content).toBe('{"greeting":"hallo"}');

    const result = await done;
    expect(result.fullText).toBe('{"greeting":"hallo"}');
    expect(await firstOutcome).toEqual({ ok: true });
  });

  test("an error still wins over structured (no delta emitted, firstOutcome is a failure)", async () => {
    async function* errorEvents(): AsyncGenerator<OpenCodeEvent> {
      yield {
        id: "evt1",
        type: "message.updated",
        properties: {
          sessionID: SESSION_ID,
          info: {
            id: "msg1",
            sessionID: SESSION_ID,
            role: "assistant",
            parentID: "",
            modelID: "gpt-5.4",
            providerID: "openai",
            mode: "build",
            agent: "build",
            path: { cwd: "", root: "" },
            cost: 0,
            tokens: { total: 0, input: 0, output: 0 },
            time: { created: 0, completed: 1 },
            error: { message: "boom" },
            structured: { greeting: "should not appear" },
          },
        },
      } as OpenCodeEvent;
    }

    const { stream, done, firstOutcome } = createOpenAIChatStream(errorEvents(), SESSION_ID, "openai/gpt-5.4");
    const frames = await readFrames(stream);

    expect(frames.some((f) => f.choices?.[0]?.delta?.content)).toBe(false);
    expect(await firstOutcome).toEqual({ ok: false, message: "boom" });

    const result = await done;
    expect(result.fullText).toBe("");
    expect(result.errorMessage).toBe("boom");
  });
});
