# opencode-box

An OpenAI-compatible API gateway (`/v1/chat/completions`, `/v1/responses`, `/v1/models`) in front of
OpenAI, Anthropic and OpenRouter - including ChatGPT and Claude Pro/Max subscriptions. Providers are
called in-process through [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai),
so requests go upstream with only what the client sent: no agent system prompt, the conversation as
real turns, and streaming passed through token by token. The gateway and a SQLite-backed admin
dashboard (API keys, provider logins, aliases, request logs) run as a single process in one Docker
container.

> The gateway used to front [OpenCode](https://opencode.ai) (`opencode serve`); that backend has been
> replaced by pi-ai. The project keeps its name.

A Docker image is built and published to `ghcr.io/hpolthof/opencode-box` automatically on every
push to `main` (see `.github/workflows/docker-publish.yml`).

## Build & run

Pull the published image:

```bash
docker pull ghcr.io/hpolthof/opencode-box:latest
```

Or build it yourself:

```bash
docker compose build
docker compose up -d
```

Environment variables (put them in a `.env` file next to `docker-compose.yml`, or export them in
your shell - `docker compose` reads a `.env` file automatically):

| Variable               | Required | Description                                                                          |
| ---------------------- | -------- | ------------------------------------------------------------------------------------ |
| `ADMIN_PASSWORD`       | yes      | Password for the `/admin` dashboard.                                                 |
| `ADMIN_SESSION_SECRET` | yes      | Long random string used to sign the admin session cookie.                            |
| `OPENAI_API_KEY`       | no       | OpenAI API key. Can also be set (or replaced by a ChatGPT sign-in) in the dashboard. |
| `ANTHROPIC_API_KEY`    | no       | Same, for Anthropic (or a Claude Pro/Max sign-in).                                   |
| `OPENROUTER_API_KEY`   | no       | Same, for OpenRouter.                                                                |

The container fails fast (exits immediately with an error) if `ADMIN_PASSWORD` or
`ADMIN_SESSION_SECRET` are missing.

## First boot

1. Visit `http://<host>:8080/admin` and log in with `ADMIN_PASSWORD`.
2. On **Providers**, connect at least one provider:
   - **Set API key** - paste an OpenAI, Anthropic or OpenRouter API key.
   - **Sign in** with a subscription account: *Sign in with ChatGPT*, *Anthropic (Claude Pro/Max)*
     or *Sign in with OpenRouter*. The sign-in page opens the provider's login in a new tab. When
     the login ends on a page that cannot be reached (a `localhost` address inside the container),
     copy that final URL from the browser's address bar and paste it back on the sign-in page.

   A provider has one credential at a time: setting an API key replaces a sign-in and vice versa.
   Credentials set in the dashboard take precedence over the environment variables above. OAuth
   tokens are refreshed automatically.
3. Create an API key on the **Keys** page. **It is shown once - copy it immediately.**

## Using the API

Model IDs are `provider/model` strings, e.g. `openai/gpt-5.6-luna`,
`anthropic/claude-sonnet-4-5` or `openrouter/meta-llama/llama-3.3-70b-instruct`. List what the
connected providers offer (plus your aliases) with:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer <your-api-key>"
```

Chat completion (add `"stream": true` to stream it):

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Responses API:

```bash
curl http://localhost:8080/v1/responses \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-5.6-luna", "instructions": "Be brief.", "input": "Hello!"}'
```

- **Structured output**: see [Structured output](#structured-output) below.
- **Reasoning**: `reasoning_effort` (chat), `reasoning.effort` (responses) or a `#level` suffix on the
  model id: `none` (off; `off` works too), `minimal`, `low`, `medium`, `high`, `xhigh`, `max` - as
  far as the model supports them (`GET /v1/models` lists them per model as `variants`). Without one,
  a request gets as little reasoning as the model allows: `none` where it can be switched off,
  otherwise its lowest level. The level used is recorded in the request log.
- **Usage**: non-streaming responses carry `usage`; for streaming chat completions, send
  `stream_options: {"include_usage": true}` to get a final usage chunk.
- **ChatGPT subscription**: with *Sign in with ChatGPT*, only the models the subscription includes
  are offered (OpenAI rejects the others); an OpenAI API key exposes the full OpenAI catalog.

## Structured output

`response_format: {"type": "json_schema", "json_schema": {...}}` (chat) or `text.format` (responses)
is mapped to each provider's native structured output - OpenAI `response_format` / `text.format`,
Anthropic `output_config.format` - streaming or not. `name` and `strict` are forwarded as sent, so
the result is what the client would get from the provider directly:

- **With `strict: true`** the provider guarantees output that matches the schema, but the schema
  itself must be valid for the provider's strict mode. For OpenAI that means `additionalProperties:
  false` on every object and every property listed in `required`; express optional fields as
  nullable (`"type": ["string", "null"]`). A schema that breaks these rules is rejected by the
  provider (`invalid_json_schema`).
- **Without `strict`** the schema guides the model but is not enforced: expect occasional
  violations, for example of `minItems`/`maxItems`. Validate the result if it matters.

The OpenCode-based version of this gateway dropped `strict` and `name`, so OpenAI always received a
non-strict schema. Clients that send `strict: true` with a schema that isn't strict-valid worked by
accident there and fail now - fix the schema (or drop `strict`).

## Aliases

An alias (Admin > Aliases) is a client-facing model name that maps to one or more
`provider/model` + reasoning-level targets, tried in priority order or in a random order per request.
A target that fails (provider error, unavailable, no first token within 120s) falls over to the next.

## Admin dashboard

- **Dashboard** - at-a-glance usage and estimated cost.
- **Playground** - try any model, streaming or not, with an optional JSON schema.
- **Keys** - create and revoke API keys, optionally restricted to certain models/aliases.
- **Requests** - request log (model, reasoning level, status, latency, tokens, cost).
- **Providers** - connect providers with an API key or a subscription sign-in.
- **Models** - every model the connected providers offer, with pricing.
- **Aliases** - see above.
- **Maintenance** - keeps the gateway's own SQLite database from growing unbounded: purge request
  logs (by age or all at once), purge old revoked API keys, set a retention period so purging runs
  automatically every hour, vacuum the database to reclaim disk space, and export the request log
  as CSV before purging. Both the automatic and manual purge have a "soft purge" checkbox that
  clears just the stored request/response bodies instead of deleting the row, so token/latency/model
  stats stay intact forever while the bulk of the storage (the bodies) still gets freed.

## Limitations

- No OpenAI function/tool-calling proxying.
- No `/v1/embeddings`, no legacy `/v1/completions`.
- Stateless: no `previous_response_id`; clients send the full conversation on every call.
- `json_object` response format is passed through to OpenAI and OpenRouter only; Anthropic ignores it.
- Using Claude Pro/Max or ChatGPT subscriptions through a third-party gateway may conflict with the
  provider's terms of service - check them before relying on it.

## Data & persistence

Everything that needs to survive a restart lives in `/data/opencode-box.sqlite` (bound to `./data`
on the host by `docker-compose.yml`): API keys, provider credentials (API keys and OAuth tokens,
stored unencrypted - protect the volume accordingly), aliases, settings and request logs. Do not
delete it unless you intend to lose all of that.

Upgrading from the OpenCode-based version: the old `/data/opencode-home` directory is no longer
used and can be removed; provider logins have to be redone once in the dashboard. Aliases, key
allow-lists and logs that referenced `pi/<provider>/<model>` ids from the pi-ai proof of concept
are migrated to the plain `provider/model` form automatically. Note that `strict` in structured
output is now forwarded to the provider (see [Structured output](#structured-output)).

## Local development

```bash
bun install
cp .env.example .env   # then fill in ADMIN_PASSWORD / ADMIN_SESSION_SECRET
bun run dev
ADMIN_PASSWORD=test-password ADMIN_SESSION_SECRET=x DB_PATH=/tmp/test.sqlite bun test
```
