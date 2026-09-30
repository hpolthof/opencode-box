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
} as const;
