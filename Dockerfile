# --- deps: install JS dependencies -----------------------------------------
FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- opencode: install the opencode CLI binary ------------------------------
FROM oven/bun:1-slim AS opencode
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://opencode.ai/install | bash

# --- final: assemble the runtime image --------------------------------------
FROM oven/bun:1-slim
WORKDIR /app

# python3 backs the admin web terminal (src/terminal/pty-bridge.py): it
# allocates a real PTY for the shell, which Bun/Node cannot do without a
# native addon.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
    && find /usr -depth -name '__pycache__' -exec rm -rf {} +

COPY --from=opencode /root/.opencode/bin/opencode /usr/local/bin/opencode
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
# Must match OPENCODE_HOME (see docker-compose.yml / src/config.ts). Setting it
# as the image-wide HOME too means an interactive `docker exec -it <container>
# opencode auth login` writes to the same persisted location that the gateway's
# own `opencode serve` process reads from - without this, exec sessions default
# to HOME=/root and any login done that way is silently lost on restart and
# invisible to the running server.
ENV HOME=/data/opencode-home
EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
