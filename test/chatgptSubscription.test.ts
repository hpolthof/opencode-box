import { afterAll, describe, expect, test } from "bun:test";
import { createModels, InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { findPiModel, listPiModels, setPiModelsForTesting } from "../src/piai/models";

afterAll(() => setPiModelsForTesting(null));

async function withOpenAICredential(credential: Credential) {
  const store = new InMemoryCredentialStore();
  await store.modify("openai", async () => credential);
  const models = createModels({ credentials: store });
  models.setProvider(openaiProvider());
  setPiModelsForTesting(models, store);
}

describe("OpenAI models by auth type", () => {
  test("Sign in with ChatGPT: only the subscription's models are offered", async () => {
    await withOpenAICredential({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 });
    const ids = (await listPiModels()).map((m) => m.id);
    expect(ids).toContain("openai/gpt-5.6-luna");
    expect(ids).toContain("openai/gpt-5.5");
    expect(ids).not.toContain("openai/gpt-5.4-mini");
    expect(ids).not.toContain("openai/gpt-4o");
    expect(await findPiModel("openai/gpt-5.4-mini")).toBeNull();
    expect(await findPiModel("openai/gpt-5.6-luna")).not.toBeNull();
  });

  test("API key: the full OpenAI catalog", async () => {
    await withOpenAICredential({ type: "api_key", key: "sk-test" });
    const ids = (await listPiModels()).map((m) => m.id);
    expect(ids).toContain("openai/gpt-5.4-mini");
    expect(ids).toContain("openai/gpt-4o");
    expect(ids.length).toBeGreaterThan(20);
  });
});
