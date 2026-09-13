import { describe, expect, test } from "bun:test";
import { createResponsesStream } from "../src/openai/responsesStream";
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
      expect(raw.startsWith("data: ")).toBe(true);
      const jsonStr = raw.slice("data: ".length);
      expect(jsonStr).not.toBe("[DONE]");
      frames.push(JSON.parse(jsonStr));
    }
  }
  return frames;
}

async function* successEvents(): AsyncGenerator<OpenCodeEvent> {
  yield {
    id: "evt1",
    type: "message.part.updated",
    properties: {
      sessionID: SESSION_ID,
      part: { id: "part1", sessionID: SESSION_ID, messageID: "msg1", type: "text", text: "Hello" },
      time: {},
    },
  } as OpenCodeEvent;
  yield {
    id: "evt2",
    type: "message.part.updated",
    properties: {
      sessionID: SESSION_ID,
      part: { id: "part1", sessionID: SESSION_ID, messageID: "msg1", type: "text", text: "Hello world" },
      time: {},
    },
  } as OpenCodeEvent;
  // an event for a different session must be ignored
  yield {
    id: "evt-other",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_other",
      part: { id: "partX", sessionID: "ses_other", messageID: "msgX", type: "text", text: "should not appear" },
      time: {},
    },
  } as OpenCodeEvent;
  yield {
    id: "evt3",
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
      },
    },
  } as OpenCodeEvent;
}

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
        error: { name: "APIError", message: "something broke" },
      },
    },
  } as OpenCodeEvent;
}

describe("createResponsesStream - success path", () => {
  test("emits the expected event sequence with strictly increasing sequence numbers", async () => {
    const { stream, done } = createResponsesStream(successEvents(), SESSION_ID, "resp_abc", "openai/gpt-5.4", "be terse");
    const frames = await readFrames(stream);

    const types = frames.map((f) => f.type);
    expect(types).toEqual([
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

    const seqs = frames.map((f) => f.sequence_number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    const deltas = frames.filter((f) => f.type === "response.output_text.delta");
    expect(deltas[0].delta).toBe("Hello");
    expect(deltas[1].delta).toBe(" world");

    const doneEvt = frames.find((f) => f.type === "response.output_text.done");
    expect(doneEvt.text).toBe("Hello world");

    const completed = frames.find((f) => f.type === "response.completed");
    expect(completed.response.status).toBe("completed");
    expect(completed.response.output_text).toBe("Hello world");
    expect(completed.response.usage.output_tokens).toBe(10);

    const result = await done;
    expect(result.fullText).toBe("Hello world");
    expect(result.usage?.output_tokens).toBe(10);
    expect(result.errorMessage).toBeUndefined();
  });

  test("never emits a raw [DONE] sentinel frame", async () => {
    const { stream } = createResponsesStream(successEvents(), SESSION_ID, "resp_abc", "openai/gpt-5.4", null);
    const frames = await readFrames(stream); // readFrames itself asserts no "[DONE]" frame
    expect(frames.length).toBeGreaterThan(0);
  });
});

describe("createResponsesStream - error path", () => {
  test("emits response.failed and resolves done with an error message", async () => {
    const { stream, done } = createResponsesStream(errorEvents(), SESSION_ID, "resp_err", "openai/gpt-5.4", null);
    const frames = await readFrames(stream);

    const types = frames.map((f) => f.type);
    expect(types).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.failed"]);

    const failed = frames.find((f) => f.type === "response.failed");
    expect(failed.response.status).toBe("failed");
    expect(failed.response.error.message).toBe("something broke");

    const result = await done;
    expect(result.usage).toBeNull();
    expect(result.errorMessage).toBe("something broke");
  });
});

describe("createResponsesStream - feed ends without completion", () => {
  test("still closes cleanly and resolves done", async () => {
    async function* incompleteEvents(): AsyncGenerator<OpenCodeEvent> {
      yield {
        id: "evt1",
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: { id: "part1", sessionID: SESSION_ID, messageID: "msg1", type: "text", text: "partial" },
          time: {},
        },
      } as OpenCodeEvent;
    }

    const { stream, done } = createResponsesStream(incompleteEvents(), SESSION_ID, "resp_partial", "openai/gpt-5.4", null);
    const frames = await readFrames(stream);
    const completed = frames.find((f) => f.type === "response.completed");
    expect(completed).toBeDefined();
    expect(completed.response.output_text).toBe("partial");

    const result = await done;
    expect(result.fullText).toBe("partial");
    expect(result.usage).toBeNull();
  });
});
