import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createResponsesStream } from "../src/openai/responsesStream";

const finalMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hallo daar" }],
  api: "openai-responses",
  provider: "openai",
  model: "m",
  usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
} as AssistantMessage;

async function* events(list: object[]): AsyncIterable<AssistantMessageEvent> {
  for (const e of list) yield e as AssistantMessageEvent;
}

async function frames(stream: ReadableStream<Uint8Array>): Promise<{ raw: string; events: any[] }> {
  const raw = await new Response(stream).text();
  const events = raw
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  return { raw, events };
}

describe("createResponsesStream", () => {
  test("success: full event sequence, strictly increasing sequence numbers, usage on completion", async () => {
    const built = createResponsesStream(
      events([
        { type: "text_delta", delta: "Hallo " },
        { type: "text_delta", delta: "daar" },
        { type: "done", reason: "stop", message: finalMessage },
      ]),
      "resp_1",
      "openai/m",
      "Be brief."
    );
    expect(await built.firstOutcome).toEqual({ ok: true });
    const { raw, events: evs } = await frames(built.stream);

    expect(evs.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    evs.forEach((e, i) => expect(e.sequence_number).toBe(i));
    expect(evs.at(-1).response).toMatchObject({
      id: "resp_1",
      status: "completed",
      model: "openai/m",
      output_text: "Hallo daar",
      instructions: "Be brief.",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    });
    expect(raw).not.toContain("[DONE]");
    expect(await built.done).toMatchObject({ fullText: "Hallo daar", usage: { totalTokens: 6 } });
  });

  test("error before any text: firstOutcome fails, response.failed is emitted", async () => {
    const built = createResponsesStream(
      events([{ type: "error", reason: "error", error: { ...finalMessage, stopReason: "error", errorMessage: "rate limited" } }]),
      "resp_2",
      "openai/m",
      null
    );
    expect(await built.firstOutcome).toEqual({ ok: false, message: "rate limited" });
    const { events: evs } = await frames(built.stream);
    expect(evs.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed", error: { message: "rate limited" } } });
    expect(await built.done).toMatchObject({ errorMessage: "rate limited" });
  });

  test("an event feed that ends without done still closes, as a failure", async () => {
    const built = createResponsesStream(events([{ type: "text_delta", delta: "half" }]), "resp_3", "openai/m", null);
    const { events: evs } = await frames(built.stream);
    expect(evs.at(-1).type).toBe("response.failed");
    expect(await built.done).toMatchObject({ fullText: "half", errorMessage: "Stream ended without a result" });
  });
});
