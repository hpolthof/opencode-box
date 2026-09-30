# opencode-box

An OpenAI Chat Completions-compatible API gateway in front of [OpenCode](https://opencode.ai),
the sst/opencode AI coding-agent CLI. Everything - the gateway, the OpenCode server it manages,
and a SQLite-backed admin dashboard for API keys and request logs - runs as a single process
inside one Docker container.

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

Required environment variables (put them in a `.env` file next to `docker-compose.yml`, or export
them in your shell - `docker compose` reads a `.env` file automatically):

| Variable                | Required | Description                                                        |
| ------------------------ | -------- | -------------------------------------------------------------------- |
| `ADMIN_PASSWORD`         | yes      | Password for the `/admin` dashboard.                                |
| `ADMIN_SESSION_SECRET`   | yes      | Long random string used to sign the admin session cookie.          |
| `ANTHROPIC_API_KEY`      | no       | Passed through to the OpenCode process if you reference it from `opencode.json`; also enables `pi/anthropic/...` models. |
| `OPENAI_API_KEY`         | no       | Same, for OpenAI (and `pi/openai/...` models).                     |
| `OPENROUTER_API_KEY`     | no       | Same, for OpenRouter.                                               |

The container fails fast (exits immediately with an error) if `ADMIN_PASSWORD` or
`ADMIN_SESSION_SECRET` are missing.

## First boot

1. Visit `http://<host>:8080/admin` and log in with `ADMIN_PASSWORD`.
2. Create your first API key on the Keys page. **It is shown once - copy it immediately.**
3. Configure at least one model provider for OpenCode itself:

   - **API-key-based providers** (Anthropic, OpenAI, OpenRouter, etc.): set the matching env var
     above, then reference it from an `opencode.json` config using OpenCode's `{env:VAR_NAME}`
     interpolation syntax. See the
     [OpenCode provider configuration docs](https://opencode.ai/docs/providers/) for the exact
     format. This file should live at `/data/opencode-home/.config/opencode/opencode.json` inside
     the container (i.e. `./data/opencode-home/.config/opencode/opencode.json` on the host) so it
     survives container restarts.

   - **Subscription/OAuth providers** (ChatGPT Plus, Claude Pro, GitHub Copilot, etc.): these
     require a one-time interactive login that cannot be automated or baked into the image. Run:

     ```bash
     docker exec -it <container_name> opencode auth login
     ```

     and follow the prompts. Credentials persist under `/data/opencode-home`, so you only need to
     do this once per deployment (until the credentials expire or you wipe the volume).

## Using the API

Model IDs are `provider/model` strings (e.g. `anthropic/claude-sonnet-4-5`). List the models
OpenCode has configured with:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer <your-api-key>"
```

Non-streaming chat completion:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Streaming chat completion:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Admin dashboard

- **Dashboard** - at-a-glance usage overview.
- **Keys** - create and revoke API keys.
- **Requests** - recent request log (model, status, latency, tokens).
- **Providers** - status of the providers OpenCode currently has configured.
- **Terminal** - a full interactive shell inside the container, in the browser. Same trust level as
  `docker exec -it <container> bash` - anyone with the admin password can run arbitrary commands.
- **Maintenance** - keeps the gateway's own SQLite database from growing unbounded: purge request
  logs (by age or all at once), purge old revoked API keys, set a retention period so purging runs
  automatically every hour, vacuum the database to reclaim disk space, and export the request log
  as CSV before purging. Both the automatic and manual purge have a "soft purge" checkbox that
  clears just the stored request/response bodies instead of deleting the row, so token/latency/model
  stats stay intact forever while the bulk of the storage (the bodies) still gets freed.

## v1 limitations

- No OpenAI function/tool-calling proxying.
- No `/v1/embeddings`.
- No legacy `/v1/completions`.
- Each chat completion call maps to a brand-new, short-lived OpenCode session - there is no
  server-side conversation memory beyond what the client sends in each call's `messages` array.

## Experimental: pi-ai backend (proof of concept)

Model ids starting with `pi/` - e.g. `pi/anthropic/claude-sonnet-4-5` or `pi/openai/gpt-5-mini#low` -
bypass OpenCode on `POST /v1/chat/completions` and call the provider in-process through
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai). Unlike the OpenCode
path, no agent system prompt is added (only your own system messages go upstream), the `messages`
history is sent as real turns instead of one flattened transcript, and streaming is passed through
token by token.

- Providers: Anthropic, OpenAI and GitHub Copilot. Sign in from **Admin > Providers** (Claude
  Pro/Max, ChatGPT or Copilot subscription via OAuth - the sign-in page walks through the auth URL
  or device code and takes the pasted redirect URL), or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  in the gateway's own environment. A dashboard sign-in wins over an env key. OAuth credentials are
  stored in the gateway's SQLite database (`pi_credentials`) and refreshed automatically. Models show
  up in `GET /v1/models` (owned by `pi-ai`) once their provider has credentials.
- `reasoning_effort` (or a `#level` suffix) takes pi-ai's levels: `none` (reasoning off; `off` works
  too), `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, as far as the model supports them.
- `response_format: json_schema` is mapped to each API's native structured output (OpenAI
  `response_format` / `text.format`, Anthropic `output_config.format`).
- `stream_options.include_usage` adds a final usage chunk.
- pi models appear everywhere OpenCode models do: the Models, Keys (allowed models), Aliases and
  Playground pages, and as alias targets (failover works across OpenCode and pi-ai targets).
- With **Sign in with ChatGPT**, only the models a ChatGPT subscription includes are offered (others
  are rejected by OpenAI); an `OPENAI_API_KEY` exposes the full OpenAI catalog.
- Not yet: `/v1/responses`, tool calling.

## Reasoning level when none is given

A request without `reasoning_effort` / `#variant` gets as little reasoning as the model allows, for
OpenCode and pi-ai models alike (OpenCode's own default would be e.g. `medium` for GPT-5.x):
reasoning off (`none`) where the model supports that, otherwise its lowest level (`minimal` or
`low`). Models that only offer extra thinking budgets (`high`/`max`, e.g. Claude 4.5 or Gemini 2.5)
get no variant, which is already their minimum. The level used is recorded in the request log, and
the Playground's "Default" option shows it per model.

## Data & persistence

Everything that needs to survive a restart lives under `/data`, which `docker-compose.yml` binds
to `./data` on the host:

- `/data/opencode-box.sqlite` - the gateway's own database (API keys, request logs).
- `/data/opencode-home` - `HOME` for the spawned `opencode serve` process, i.e. its config
  (`opencode.json`), provider credentials, and any other OpenCode state.

Do not delete this directory unless you intend to lose your API keys, request history, and
provider logins.

## Local development

Requires a local `opencode` binary on `PATH` (install via `curl -fsSL https://opencode.ai/install | bash`).

```bash
bun install
cp .env.example .env   # then fill in ADMIN_PASSWORD / ADMIN_SESSION_SECRET
bun run dev
bun test
```
