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
| `ANTHROPIC_API_KEY`      | no       | Passed through to the OpenCode process if you reference it from `opencode.json`. |
| `OPENAI_API_KEY`         | no       | Same, for OpenAI.                                                   |
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

## v1 limitations

- No OpenAI function/tool-calling proxying.
- No `/v1/embeddings`.
- No legacy `/v1/completions`.
- Each chat completion call maps to a brand-new, short-lived OpenCode session - there is no
  server-side conversation memory beyond what the client sends in each call's `messages` array.

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
