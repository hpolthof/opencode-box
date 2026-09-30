# --- deps: install JS dependencies -----------------------------------------
FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- final: assemble the runtime image --------------------------------------
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
