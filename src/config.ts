function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const CONFIG = {
  port: Number(process.env.PORT ?? 8080),
  adminPassword: required("ADMIN_PASSWORD"),
  adminSessionSecret: required("ADMIN_SESSION_SECRET"),
  dbPath: process.env.DB_PATH ?? "./data/opencode-box.sqlite",
  opencodeHome: process.env.OPENCODE_HOME ?? "./data/opencode-home",
  opencodeHost: "127.0.0.1",
  opencodePort: Number(process.env.OPENCODE_PORT ?? 4096),
  terminalShell: process.env.TERMINAL_SHELL ?? "/bin/bash",
} as const;
