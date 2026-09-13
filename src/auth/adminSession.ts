import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { CONFIG } from "../config";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const ADMIN_SESSION_COOKIE = "admin_session";

function sign(payloadBase64: string): string {
  return createHmac("sha256", CONFIG.adminSessionSecret).update(payloadBase64).digest("hex");
}

/** Builds a signed `${payloadBase64}.${signatureHex}` session cookie value. */
export function signSession(): string {
  const payload = JSON.stringify({ iat: Date.now() });
  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const signatureHex = sign(payloadBase64);
  return `${payloadBase64}.${signatureHex}`;
}

/** Verifies a session cookie value: valid signature and not expired. Never throws. */
export function verifySession(cookieValue: string | undefined): boolean {
  try {
    if (!cookieValue) return false;
    const dotIndex = cookieValue.indexOf(".");
    if (dotIndex < 0) return false;
    const payloadBase64 = cookieValue.slice(0, dotIndex);
    const signatureHex = cookieValue.slice(dotIndex + 1);
    if (!payloadBase64 || !signatureHex) return false;

    const expectedSignatureHex = sign(payloadBase64);
    const a = createHash("sha256").update(signatureHex).digest();
    const b = createHash("sha256").update(expectedSignatureHex).digest();
    if (!timingSafeEqual(a, b)) return false;

    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    if (typeof payload?.iat !== "number") return false;
    return Date.now() - payload.iat < SESSION_TTL_MS;
  } catch {
    return false;
  }
}

/** Safely compares a candidate password against the configured admin password. */
export function checkPassword(candidate: string): boolean {
  try {
    const a = createHash("sha256").update(candidate).digest();
    const b = createHash("sha256").update(CONFIG.adminPassword).digest();
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Hono middleware: redirects to /admin/login unless a valid admin session cookie is present. */
export async function requireAdmin(c: Context, next: Next) {
  const cookieValue = getCookie(c, ADMIN_SESSION_COOKIE);
  if (!verifySession(cookieValue)) {
    return c.redirect("/admin/login", 302);
  }
  await next();
}
