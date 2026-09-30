# Open issues: pi-ai gateway (branch `poc/pi-ai`)

Found on 2026-09-30 while testing this branch (at `bf44f04`) with a downstream client app. The app makes about two dozen kinds of structured AI calls, and each one was run against three models: `openai/gpt-5.6-luna`, `openai/gpt-6-luna` and `openai/gpt-6.1-sol`. The results were compared with the deployed OpenCode-based version of the gateway as a baseline.

Each issue below is self-contained, so it can be picked up on its own. Line numbers refer to `bf44f04`.

**Status (2026-09-30):** all six issues are resolved on `poc/pi-ai` (up to `834489a`). Each issue ends with a **Resolution** section: what changed, how it was verified, and caveats. "Live" below means verified against the running gateway through the `/v1` API with an API key, using a *Sign in with ChatGPT* account (models `openai/gpt-5.6-luna`, `openai/gpt-6-luna`, `openai/gpt-6.1-sol`). No OpenAI or Anthropic API key was available, so paths that need one were verified against fake upstreams in the test suite only (178 tests at `834489a`).

| # | Issue | Priority | Status |
|---|---|---|---|
| 1 | [An explicit `effort: none` fails on models without a "none" level](#1-an-explicit-effort-none-fails-on-models-without-a-none-level) | High | Resolved (`7aa947f`) |
| 2 | [Request parameters are dropped: output token cap, temperature, prompt cache key](#2-request-parameters-are-dropped-output-token-cap-temperature-prompt-cache-key) | High | Resolved, with a ChatGPT sign-in limitation (`440e5fe`) |
| 3 | [Upstream client errors come back as 502](#3-upstream-client-errors-come-back-as-502) | Medium | Resolved (`33d24e6`, `834489a`) |
| 4 | [Report which model and reasoning level actually served the request](#4-report-which-model-and-reasoning-level-actually-served-the-request) | Medium | Resolved (`6f0c603`) |
| 5 | [Aliases silently override the client's reasoning effort](#5-aliases-silently-override-the-clients-reasoning-effort) | Medium (design decision) | Resolved: option 1 (`7aa947f`) |
| 6 | [Document that `strict` structured output is now forwarded](#6-document-that-strict-structured-output-is-now-forwarded) | Low (docs) | Resolved (`fb6c12c`) |

---

## 1. An explicit `effort: none` fails on models without a "none" level

**What happens.** Consider a request for `openai/gpt-6.1-sol` with `reasoning: { effort: "none" }`. The request fails with a 400:

```
Variant "none" is not available for model "openai/gpt-6.1-sol". Available variants: low, medium, high, xhigh, max
```

Clients commonly send `none` for cheap, extraction-style calls where reasoning adds nothing. In the test client, six kinds of calls do this, and all six failed on sol while working on both luna models. For such a client, switching models to sol is enough to break those calls completely.

**Why.** `resolveRequestedModel` in `src/routes/v1.ts:191-207` only treats `none`/`off` specially when a model has no reasoning levels at all:

```ts
} else if ((variant === "none" || variant === "off") && !matched.variants?.length) {
  variant = undefined;
}
```

A model that has levels but not `none`/`off` falls through to the "variant not available" error. This is inconsistent with the intent of `eedc0de` ("as little reasoning as the model allows"). That commit already applies the intent when no level is requested (`defaultReasoningVariant` in `src/reasoning.ts`), but not when the client explicitly asks for `none`.

**Proposed fix.** Treat an explicit `none`/`off` as a request for the minimum. If the model has no `none`/`off`, fall back to `defaultReasoningVariant(matched.variants)`: its lowest effort level, or no level at all when the model only offers high thinking budgets. Other unknown levels (for example a typo) should keep returning 400.

**Also check.** Alias targets are pinned to a variant (`#none`). Check that an alias whose target lacks that level either maps it the same way or fails at alias-save time, not at request time. Today `prepare()` in `src/piai/run.ts:29-31` rejects it per target, which triggers a failover.

**Acceptance.**
- `effort: none` on `openai/gpt-6.1-sol` returns 200 and runs at `low`.
- The level that was used is logged, and ideally reported in a header (see issue 4).
- `effort: turbo` still returns 400.
- Unit tests are added next to `src/reasoning.ts`.

### Resolution

**Status:** resolved in `7aa947f` (merged in `a098813`).

**What changed.**
- New `resolveReasoningVariant(requested, variants, { clamp? })` and `isReasoningLevel()` in `src/reasoning.ts`. `resolveRequestedModel` in `src/routes/v1.ts` uses it for every request.
- An explicit `none` or `off` now means "as little reasoning as this model allows". On a model with a `none`/`off` level, that level is sent. Otherwise it falls back to `defaultReasoningVariant()`: the model's lowest effort level (`minimal`, then `low`), or no level at all when the model only offers high thinking budgets (`high`/`max`).
- Anything that isn't a reasoning level (`turbo`) is still a 400 `variant_not_found`. On a direct model request, a real level the model doesn't offer (e.g. `minimal` on sol) is also still a 400. Clamping to the nearest level only happens for aliases (see issue 5).
- Alias targets pinned to `#none` on a model without a none level are mapped the same way at request time. They no longer get rejected in `prepare()`, so this no longer triggers a failover.

**Verified.**
- Unit tests in `test/reasoning.test.ts` cover the mapping and clamping rules.
- Route tests run against a fake upstream with a sol-like model (no none level) and a high/max-only model. `none`/`off` runs at `low`, checked in the payload, the request log and `x-served-reasoning`. On the budget-only model, `none` sends no level and gives `x-served-reasoning: default`. `turbo` and `minimal` on sol return 400, and a pinned `#none` on sol makes exactly one upstream call.
- Live: `openai/gpt-6.1-sol` with `reasoning: { effort: "none" }` returns 200 with `x-served-reasoning: low`, and `turbo` returns 400.

**Caveats.**
- On a model that can't switch reasoning off, `none` still costs some reasoning (the lowest level). The client can see this in `x-served-reasoning`, but the response body doesn't say so.
- A pinned alias level other than `none` that a model no longer offers (e.g. after a catalog update) is still rejected per target and fails over. Only `none` is mapped.

---

## 2. Request parameters are dropped: output token cap, temperature, prompt cache key

**What happens.** The gateway forwards only the messages, the reasoning level and the response format to pi-ai. Everything else is silently ignored:

- **Output token cap.** `max_output_tokens` (Responses) and `max_tokens` / `max_completion_tokens` (Chat Completions) never reach the provider. Observed: a call with `max_output_tokens: 600` used 1,251 output tokens (1,016 of them reasoning) and still reported `status: "completed"`. Clients use this cap as a cost ceiling and to bound latency, and now neither works. Clients also can't rely on getting `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"` when a response hits the cap.
- **`temperature`** (and `top_p`). The test client sets 0 for extraction and 0.5 for writing tasks; neither has any effect.
- **`prompt_cache_key`.** Clients send a stable key so that requests sharing a static instruction prefix are routed to the same cache. Cached input tokens stayed at 0 throughout testing.

**Why.** `PiRunRequest` (`src/piai/run.ts:18-21`) only has `messages` and `responseFormat`. `prepare()` builds the pi-ai options from `signal`, `reasoning` and the structured-output `onPayload` hook, and nothing else. `ResponseCreateParams` (`src/openai/responsesTypes.ts:46-55`) accepts any extra key through `[key: string]: unknown`, so the fields are accepted and then lost. `grep` finds no reference to `max_output_tokens`, `max_tokens`, `prompt_cache_key` or `top_p` anywhere in `src/`. `temperature` only appears in the Chat Completions type.

**Proposed fix.**
- Add these fields to `PiRunRequest`: the token cap, `temperature`, `top_p` and `prompt_cache_key`.
- Map both endpoints onto them: `max_output_tokens` from Responses, and `max_completion_tokens` / `max_tokens` from Chat.
- Pass them through as the matching pi-ai options where pi-ai supports them (check the names it uses, for example a max-tokens option). Otherwise add them through the existing `onPayload` hook, per API: `max_output_tokens` for `openai-responses`, `max_completion_tokens` for `openai-completions`, `max_tokens` for `anthropic-messages`.
- The token cap should be one-to-one: the value the client sends is the value the provider gets. Note that for OpenAI reasoning models the cap includes reasoning tokens. That is the provider's semantics and should not be adjusted.
- When the provider stops on the cap, return `status: "incomplete"` with `incomplete_details: { reason: "max_output_tokens" }` (Responses) or `finish_reason: "length"` (Chat), instead of `completed`.

**Watch out.**
- Some OpenAI reasoning models reject `temperature`/`top_p` (400 "Unsupported parameter"). Decide deliberately between two options: drop the parameter for models that don't support it (and say so in a log line), or pass the provider's 400 through (see issue 3). Silently dropping it for every model, as happens now, is the one option to avoid.
- `prompt_cache_key` is OpenAI-specific. Anthropic uses `cache_control` breakpoints instead, so only forward it for the OpenAI APIs.

**Acceptance.**
- A Responses call with `max_output_tokens: 50` and a long-answer prompt comes back `incomplete` with at most 50 output tokens.
- `temperature: 0` reaches the provider payload (assert it in a test through the `onPayload` hook).
- Repeated calls with the same long static `instructions` and the same `prompt_cache_key` show `cached_tokens > 0` on OpenAI.

### Resolution

**Status:** resolved in `440e5fe` (merged in `e132d76`). One limitation can't be fixed: *Sign in with ChatGPT* doesn't accept the cap, `temperature` or `top_p` (see Caveats).

**What changed.**
- **New fields.** `PiRunRequest` (`src/piai/run.ts`) now carries `maxOutputTokens`, `temperature`, `topP` and `promptCacheKey`. They are read from `max_output_tokens`, `temperature`, `top_p` and `prompt_cache_key` (Responses), and from `max_completion_tokens` / `max_tokens`, `temperature`, `top_p` and `prompt_cache_key` (Chat).
- **Where each parameter goes.** New `src/piai/params.ts` decides this per model and auth:
  - The cap goes to pi-ai's `maxTokens` and `temperature` to its `temperature`.
  - `top_p` goes to `samplingParams` for the OpenAI-style APIs, and through the payload hook for Anthropic.
  - `prompt_cache_key` becomes pi-ai's `sessionId`. The Responses adapter sends it as `prompt_cache_key`, but only for provider `openai`.
- **Anthropic cap.** For Anthropic, the output cap is kept exactly one-to-one: the thinking budget is shrunk to fit under it, instead of pi-ai adding the budget on top. If the cap is too small for the minimum thinking budget (1024), thinking is switched off, with a log line.
- **Cap reached.** A response that stops on the cap comes back as `status: "incomplete"` with `incomplete_details: { reason: "max_output_tokens" }` on `/v1/responses`. When streaming, it ends with a `response.incomplete` event. Chat returns `finish_reason: "length"`. Every other response now carries `incomplete_details: null`, as OpenAI's does.
- **Unsupported parameters are dropped, not silently.** Per product decision, they are left out rather than failing the request, and each drop is visible in three places: a log line, the `x-dropped-params` response header (issue 4), and the request-log notes. The cases:
  - *Sign in with ChatGPT*: the cap, `temperature` and `top_p`.
  - Anthropic models that reject `temperature`, or that have managed effort or extended thinking on: `temperature` and `top_p`.
  - Anthropic when both are sent: `top_p`.
  - OpenAI models that answer "Unsupported parameter: temperature/top_p" at runtime: the target is retried once without the parameter, and the model is remembered in memory so later calls drop it up front.

**Verified.**
- Tests in `test/params.test.ts` use fake upstreams:
  - `temperature: 0`, `top_p` and the cap reach the payload.
  - On a fake OpenAI Responses provider, `max_output_tokens`, `prompt_cache_key` and `temperature` reach the payload, and a cap of 5 is raised to 16.
  - A stop on the cap gives Chat `length` and Responses `incomplete` (both modes).
  - The "Unsupported parameter" retry happens exactly once, and the next call sends a single request.
- Live, with *Sign in with ChatGPT*:
  - `max_output_tokens: 50` plus `temperature: 0` returns 200 with `x-dropped-params: max_output_tokens, temperature`, and the request log notes "not forwarded: max_output_tokens, temperature".
  - `prompt_cache_key` demonstrably reaches the ChatGPT backend (checked in the outgoing payload), but see Caveats.

**Caveats.**
- **Sign in with ChatGPT can't be capped.** The ChatGPT backend rejects `max_output_tokens`, `temperature` and `top_p` with `400 {"detail":"Unsupported parameter: ..."}` (verified live). With that sign-in, a client's token cap therefore bounds neither cost nor latency. We considered enforcing the cap in the gateway, by cutting off the stream after N visible tokens, and decided against it. Reasoning tokens aren't streamed, so it would only cap the visible text. Clients that need a hard cap should use a provider configured with an OpenAI API key.
- **The OpenCode-based gateway didn't forward any of these parameters either.** It never read `max_tokens` / `max_output_tokens` / `temperature`, and OpenCode itself always sent `max_tokens: 32000`. So there is no regression for ChatGPT sign-in users: it now works with an API key, and is reported where it can't.
- **Prompt caching not confirmed.** Three identical calls with a 1,589-token instruction prefix and the same `prompt_cache_key` reported `cached_tokens: 0`. The same happened when calling pi-ai directly. The ChatGPT backend apparently doesn't cache or doesn't report it. The acceptance criterion "`cached_tokens > 0` on OpenAI" is unverified for API-key use: no key was available.
- **No live API-key test.** The acceptance criterion "`max_output_tokens: 50` comes back incomplete" is verified against a fake OpenAI Responses upstream only.
- **Parameters rejected at runtime are remembered per model, not per reasoning level.** If a model accepts `temperature` only with reasoning off, it is dropped at every level once rejected. The memory resets on restart.
- **Floor.** OpenAI Responses rejects caps below 16, so pi-ai raises them to 16. That is the one deviation from one-to-one.
- **Wrong types are ignored.** A value of the wrong type (e.g. `temperature: "0"`) is ignored rather than answered with a 400.
- **Playground.** The admin Playground doesn't expose these parameters.

---

## 3. Upstream client errors come back as 502

**What happens.** When the provider rejects a request as invalid, the client gets `502 api_error` with the provider's message embedded in the text. Example: a JSON schema that is invalid for strict mode.

```
AI provider error (502): OpenAI API error (400): {"message":"Invalid schema for response_format '...': In context=(), 'additionalProperties' is required to be supplied and to be false.","type":"invalid_request_error","param":"text.format.schema","code":"invalid_json_schema"}
```

A 502 tells the client the gateway or upstream is down, so a well-behaved client may retry. Retrying can never succeed here, because the request itself is wrong. It also hides the useful fields (`param`, `code`) inside a string.

**Why.** Every failed target result becomes `c.json(openAIError(result.message, "api_error"), 502)` (`src/routes/v1.ts:361-362`, `375-376`, `439-440`, `452-453`). The upstream status, type, param and code are lost in `result.message`.

**Proposed fix.**
- Keep the upstream status and error object in the failed target result.
- Pass 4xx provider errors (400, 401/403 from the provider, 404, 422, 429) through with their original `type`, `param` and `code`.
- Keep 502 for real gateway or upstream failures: network errors, timeouts, 5xx.
- Don't fail over to the next alias target on a 400 `invalid_request_error`. The next target would reject the same request, which only adds latency. Do keep failing over on 5xx, timeouts and 429.

**Acceptance.** A request with an invalid strict schema returns 400 with `code: "invalid_json_schema"` and `param: "text.format.schema"`, and makes exactly one upstream attempt even through an alias with two targets.

### Resolution

**Status:** resolved in `33d24e6` (merged in `dc94c4a`). `834489a` adds failover on a provider 404.

**What changed.**
- **Structured failures.** New `src/piai/errors.ts` defines `TargetError { status, message, type, code?, param?, failover }`, and every failed target now returns `{ ok: false, error: TargetError }` instead of a bare message.
- **Classification.**
  - Provider 400, 401, 403, 404, 413, 422 and 429 keep their status and the provider's `message`, `type`, `code` and `param`. When the provider gives no `type`, a sensible default is filled in (e.g. `invalid_request_error` for 400, `rate_limit_error` for 429).
  - Network errors, the per-target timeout, provider 5xx and unrecognised failures stay 502 `api_error`.
- **Where the status comes from.** pi-ai only exposes errors as text, so the status is taken from the actual HTTP response where possible. A wrapped `fetch` records it, plus a copy of the error body, for the OpenAI, Azure, Codex, Anthropic and Mistral adapters. pi-ai's `onResponse` hook covers Codex. Everything else falls back to parsing pi-ai's error message. These body shapes are recognised: bare `{message,type,param,code}`, `{"error":{...}}`, Anthropic's `{"type":"error","error":{...}}`, `{"error":"text"}` and the ChatGPT backend's `{"detail":...}`.
- **Failover.**
  - No failover on 400, 413 and 422: the next target would reject the same request.
  - Failover continues on 5xx, timeouts, network errors, 429, 401/403 (another target may sit on a different provider) and "model not available".
  - A provider **404** also fails over (`834489a`, decided afterwards): providers use it for "model not found", which is specific to one target.
- **Responses and logging.** Routes answer `{ error: { message, type, code?, param? } }` with the classified status, and the request log records that status. `openAIError()` gained a `param` argument.

**Verified.**
- Tests in `test/providerErrors.test.ts`:
  - The parser handles all of the message shapes above.
  - A 400 `invalid_json_schema` through a two-target alias returns 400 with `code`/`param` intact on both endpoints, streaming and not, with exactly one upstream request (counted at the fake server).
  - The same holds through the OpenAI Responses and Anthropic adapters.
  - A direct 429 returns 429, and a direct 500 returns 502.
  - A 500, a 404, a 429 and a refused connection each fail over to the second target, on all four endpoint/stream combinations.
- Live: an invalid strict schema returns 400 `invalid_json_schema` with `param: "text.format.schema"` on `/v1/responses`, and also on a streaming `/v1/chat/completions` through a two-target alias.

**Caveats.**
- A provider **401/403** is passed through as 401/403. A client may read that as a problem with *its own* gateway API key; the message is the provider's, though.
- Other 4xx statuses (402, 408, 409, ...) become 502 and fail over.
- Streams that have already started still report errors in-stream, as before. The HTTP status is already 200 by then.
- The admin Playground's *streaming* path still reports provider errors in-stream with HTTP 200, because its stream opens lazily. The non-streaming path uses the new statuses.
- The `fetch` wrapper isn't applied to adapters that don't accept one (Google, Bedrock, Cloudflare). They rely on `onResponse` and the message parser. None of them are configured today.

---

## 4. Report which model and reasoning level actually served the request

**What happens.** For a request to an alias, the response's `model` field is the alias name (for example `luna`). The client can't tell which target served it (primary or failover), or which reasoning level was used after resolution: explicit, default, alias-pinned or mapped (issue 1). This made a real problem hard to debug. An English translation from an alias came back containing an Arabic word in 2 of 2 runs. The same model called directly did not do that, and the client had no way to see whether a failover to the other target had happened.

**Proposed fix.** Add response headers on both endpoints, on both streaming and non-streaming responses:

- `x-served-model`: the concrete `provider/model` of the target that produced the response, for example `openai/gpt-6-luna`.
- `x-served-reasoning`: the reasoning level actually sent to the provider after all resolution (`none`, `low`, `medium`, ...). Use a clear value such as `default` when no level was sent, because the model only offers high thinking budgets.
- Optionally `x-alias-target-index` or `x-failover: true` when a target other than the first one served the request.

Headers are the safest place because they don't alter the OpenAI response shape that clients and SDKs parse. The same values should already be in the request log. Check that the admin request viewer shows them for alias requests.

**Acceptance.** An alias request whose first target is made to fail returns `x-served-model` = second target, plus `x-served-reasoning`. A direct request with `effort: none` on sol returns `x-served-reasoning: low` (after issue 1).

### Resolution

**Status:** resolved in `6f0c603`.

**What changed.**
- **Headers.** Every successful response from `/v1/chat/completions` and `/v1/responses`, streaming or not, carries:
  - `x-served-model`: the `provider/model` that answered. For an alias, that is the target that served it.
  - `x-served-reasoning`: the level sent to the provider after all resolution, or `default` when none was sent (a model that only offers high budgets).
  - `x-alias-target-index` (aliases only): the 0-based position of the serving target.
  - `x-failover: true`: when that wasn't the first target.
  - `x-reasoning-overridden: true`: when the client sent an effort to an alias that pins its levels (issue 5).
  - `x-dropped-params`: parameters that were not forwarded to this model (issue 2).
- **Request log.** Two new columns, added by an idempotent migration:
  - `alias`: the alias the client asked for.
  - `notes`: e.g. "failover: served by target 2 of 2", "client reasoning effort ignored: the alias pins its levels", "not forwarded: max_output_tokens, temperature".
  - As before, `model` and `variant` hold the serving target and level.
- **Admin > Requests.** Shows "via <alias>" under the model, plus the alias and notes in the row details. The CSV export includes both columns.
- **README.** New "Response headers" section.

**Verified.**
- `test/catalog.test.ts`: an alias whose first target refuses connections returns `x-served-model` = the second target, `x-served-reasoning`, `x-alias-target-index: 1` and `x-failover: true`, streaming and not. The log row has the alias and the failover note. An effort sent to a pinning alias gives `x-reasoning-overridden: true` plus a note. A direct request has no alias headers and no notes.
- `test/reasoning.test.ts`: `none` on a sol-like model gives `x-served-reasoning: low`; on a high/max-only model it gives `default`.
- Live:
  - Direct `gpt-6.1-sol` + `none`: `x-served-model: openai/gpt-6.1-sol` and `x-served-reasoning: low`.
  - A pinning alias sent `reasoning_effort: high`: `x-served-reasoning: none`, `x-alias-target-index: 0` and `x-reasoning-overridden: true`, and the log note is present.
  - Dropped parameters show up in `x-dropped-params` and in the log.

**Caveats.**
- Headers are only set on **successful** responses. Error responses (4xx/502) carry the error body only. The request log still records the model and alias for them.
- Live failover wasn't reproduced against real providers (no failing real target was available). It is covered by the tests above.
- A failed request through an alias is logged with the alias name as `model` and no `variant`, because no target served it.

---

## 5. Aliases silently override the client's reasoning effort

**What happens.** An alias pins a variant per target (`openai/gpt-6-luna#none`), and `resolveRequestedModel` ignores the client's `reasoning.effort` for aliases (documented in the comment at `src/routes/v1.ts:116-119`). Clients that point at an alias therefore get the alias's level for every call, whatever they ask for.

In practice, a client that carefully sets `medium` for its judgement-heavy calls and `none` for extraction runs everything at `none` when it talks to the `luna` alias. This was confirmed with a reasoning puzzle: every requested level from none to high gave 0 reasoning tokens and a wrong answer. The same model called directly at `medium` used 516 reasoning tokens and answered correctly. Nothing in the response signals that the requested effort was ignored.

**This is a design decision, not necessarily a bug.** Pinning is useful: an operator can offer a cheap `luna` and a thinking `luna-smart` without clients knowing about levels. But the current behaviour is invisible to the client. Options:

1. Add a per-alias setting ("client effort overrides the pinned level"). When the client sends `reasoning.effort`, map it per target (same rules as issue 1). Otherwise use the pinned level.
2. Keep pinning, and reject or warn when a client sends an explicit effort to an alias (for example a `warning` field in the log and an `x-reasoning-overridden: true` header).
3. Keep it as is, and document it prominently in the README "Aliases" section, including the consequence that clients' own effort settings have no effect.

Option 1 combined with the header from issue 4 is the most useful for clients that manage effort per call. Whichever option is chosen, the README should state it explicitly.

### Resolution

**Status:** resolved with **option 1** in `7aa947f` (merged in `a098813`), combined with the headers from issue 4.

**What changed.**
- **New setting.** A per-alias setting, *Client effort overrides the pinned level*: DB column `model_aliases.client_effort_overrides`, **off by default**. An idempotent migration keeps existing aliases as they were. The admin alias form has a checkbox for it, and the alias list shows which aliases have it on.
- **Setting on.** A client effort (`reasoning_effort` / `reasoning.effort`) replaces every target's pinned level, adjusted per target:
  - `none`/`off` becomes the least reasoning that target allows (issue 1).
  - A level the target doesn't offer becomes the nearest one it does, preferring the next **higher** level, as pi-ai's own `clampThinkingLevel` does (e.g. `minimal` → `low`, `max` → `xhigh`). The client never gets less reasoning than it asked for when more is available.
  - A name that isn't a reasoning level (`turbo`) is a 400.
  - Without a client effort, the pinned levels apply.
- **Setting off.** Pinned levels always apply, as before. When the client did send an effort, the response carries `x-reasoning-overridden: true` and the request log gets a note.
- **README.** The "Aliases" section states this explicitly, including that a client's effort has no effect unless the setting is on.

**Verified.**
- Tests: with the setting off, `high` is ignored (the pinned `low` is sent) and flagged. With it on, each target gets its clamped level, on both endpoints, and `turbo` returns 400. The migration leaves existing aliases off. The admin form saves the checkbox both ways, and the list shows the indicator.
- Live (temporary aliases, removed afterwards):
  - A pinning alias sent `high`: `x-served-reasoning: none` and `x-reasoning-overridden: true`.
  - An alias with the setting on, sent `medium`: `x-served-reasoning: medium`. The trivial prompt used 0 reasoning tokens, so the effect on quality wasn't measured live; the level reaching the provider is covered by tests.

**Caveats.**
- **Existing aliases can't be edited in the admin.** To turn the setting on for one, delete it and recreate it.
- **Rounding up can cost more.** Clamping rounds up when a target lacks the requested level, so a target can reason more than asked. This is deliberate and visible in `x-served-reasoning`.
- **"Effort was ignored" is only signalled on success.** It is only reported in headers and log notes on successful responses (see issue 4).

---

## 6. Document that `strict` structured output is now forwarded

**What happens.** The OpenCode-based gateway dropped `text.format.strict` (and `name`), so OpenAI got a non-strict `json_schema`. The pi-ai path forwards `strict` faithfully (`src/piai/chat.ts:135-150`). That behaviour is correct: it matches what the client would get from OpenAI directly.

However, clients that send `strict: true` together with a schema that isn't valid for strict mode worked by accident before and fail now. For OpenAI, a strict-valid schema needs `additionalProperties: false` on every object, and every property must be listed in `required`, with optional fields expressed as nullable. One real client (JSON schemas generated from zod with optional fields) lost almost all of its structured calls to this after switching. The client is being fixed to send strict-valid schemas, but other clients may have the same hidden dependency.

**Proposed fix (docs only, no behaviour change).**
- Add a note to the README "Limitations" or a new "Structured output" section, and to the changelog or migration notes for the pi-ai switch: "`strict` is now forwarded to the provider. Schemas sent with `strict: true` must be valid for the provider's strict mode."
- Mention the OpenAI rules above.
- Mention that without `strict`, the schema guides the model but isn't guaranteed. In the tests, models without strict violated `maxItems`/`minItems` in about 1 of every 16 structured responses.
- Once issue 3 is done, clients also get a clear 400 `invalid_json_schema` instead of a 502.

### Resolution

**Status:** resolved in `fb6c12c` (docs only, no behaviour change).

**What changed.**
- The README has a new "Structured output" section:
  - `name` and `strict` are forwarded as sent.
  - With `strict: true`, the schema must be valid for the provider's strict mode. For OpenAI that means `additionalProperties: false` on every object and every property in `required`, with optional fields expressed as nullable. Otherwise the provider rejects it with `invalid_json_schema`.
  - Without `strict`, the schema guides the model but isn't enforced; expect occasional violations such as `minItems`/`maxItems`.
- The section also explains that the OpenCode-based gateway dropped `strict`, so such clients worked by accident.
- The upgrade notes in the "Data & persistence" section point to it.

**Verified.** With issue 3 in place, a strict-invalid schema now returns a clear 400 `invalid_json_schema` with `param`, instead of a 502. Verified live, see issue 3.

**Caveats.**
- There is no separate CHANGELOG file in the repository. The README's upgrade notes serve as the migration notes.
- The gateway doesn't validate or fix schemas itself. Rejecting or converting non-strict schemas remains the provider's and the client's job.

---

## Measured along the way (no action needed, for context)

- **Input token overhead is gone.** The OpenCode-based gateway added about 1,190 input tokens of its own system prompt to every call: a 6-word prompt cost 1,204 input tokens. On this branch the same 24 calls used 38.2k input tokens instead of 66.7k (-43%).
- **Latency floor is gone.** The OpenCode-based gateway took about 8 s even for a 7-token answer. On this branch the same kind of call took about 4.5 s.
- **Reasoning levels are honoured for direct model calls.** For example, `openai/gpt-5.6-luna` at `medium` used 516 reasoning tokens on a puzzle it failed at `none`.
- **`gpt-6.1-sol` is 2-3x slower** than the luna models on the same calls. The slowest structured call took about 110 s, which matters for client timeouts, not for the gateway.
