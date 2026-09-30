import type { Api, ProviderResponse, StreamOptions } from "@earendil-works/pi-ai";

/**
 * Why one target (a model + reasoning level) of a request failed, shaped
 * so the route can answer with it directly and decide whether trying the
 * next alias target could help.
 *
 * - Provider client errors (400, 401, 403, 404, 413, 422, 429) keep their
 *   status and the provider's `type` / `code` / `param` / `message`.
 * - Everything else - network errors, the per-target timeout, provider 5xx,
 *   unrecognised failures - is a 502 `api_error` carrying the raw message.
 *
 * `failover` is false only when the next target would reject the very same
 * request (400, 404, 413, 422): trying it only adds latency. 429, 401/403
 * (another target may sit on a different, working provider), 5xx,
 * timeouts, network errors and per-target conditions like "model not
 * available" keep failing over.
 */
export interface TargetError {
  status: number;
  message: string;
  type: string;
  code?: string;
  param?: string;
  failover: boolean;
}

/** Provider statuses passed through to the client as-is, with the OpenAI error `type` used when the provider gave none. */
const PASSTHROUGH_STATUS_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "invalid_request_error",
  413: "invalid_request_error",
  422: "invalid_request_error",
  429: "rate_limit_error",
};

/** Statuses where the request itself is wrong, so another target would fail the same way. */
const NO_FAILOVER_STATUSES = new Set([400, 404, 413, 422]);

/** A gateway-side or upstream-availability failure: 502 `api_error`, worth failing over. */
export function gatewayError(message: string): TargetError {
  return { status: 502, message, type: "api_error", failover: true };
}

interface ProviderErrorFields {
  message?: string;
  type?: string;
  code?: string;
  param?: string;
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Reads the OpenAI-style fields out of a provider error body. Handles the
 * bare object OpenAI's SDK surfaces (`{message, type, param, code}`), the
 * `{"error": {...}}` wrapper (OpenAI, Anthropic's `{"type":"error","error":{...}}`),
 * `{"error": "text"}` and the ChatGPT backend's `{"detail": "..."}`.
 * Returns null when `body` isn't a JSON object.
 */
export function parseProviderErrorBody(body: string): ProviderErrorFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  let obj = parsed as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)) {
    obj = obj.error as Record<string, unknown>;
  }
  const message =
    stringField(obj.message) ??
    stringField(obj.detail) ??
    (typeof obj.error === "string" ? obj.error : undefined) ??
    (obj.detail !== undefined ? JSON.stringify(obj.detail) : undefined);
  return {
    message,
    type: stringField(obj.type),
    code: stringField(obj.code),
    param: stringField(obj.param),
  };
}

/**
 * Splits a pi-ai `errorMessage` into the HTTP status it mentions (if any)
 * and the remaining text, which is usually the provider's JSON body. The
 * shapes pi-ai produces (see `formatProviderError` in pi-ai's
 * utils/error-body.js and the SDKs' `APIError` messages):
 *
 *   OpenAI API error (400): {"message":"...","type":"...","param":"...","code":"..."}
 *   OpenAI API error (400): 400 {"detail":"Unsupported parameter: temperature"}
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":"..."}}   (Anthropic SDK)
 *   400: {"message":"..."}
 */
export function splitProviderErrorMessage(errorMessage: string): { status?: number; rest: string } {
  let status: number | undefined;
  let rest = errorMessage.trim();
  const prefixed = /^[^\n{]*?\berror \((\d{3})\):\s*/i.exec(rest);
  if (prefixed) {
    status = Number(prefixed[1]);
    rest = rest.slice(prefixed[0].length);
  }
  const leading = /^(\d{3})(?::\s*|\s+)(?=\S)/.exec(rest);
  if (leading && (status === undefined || Number(leading[1]) === status)) {
    status = Number(leading[1]);
    rest = rest.slice(leading[0].length);
  }
  return { status, rest };
}

/**
 * Classifies a failed provider call. `httpStatus` / `rawBody` come from
 * observing the provider's HTTP response (see `createResponseProbe`) and
 * win over what can be parsed out of pi-ai's `errorMessage`; the message
 * is the fallback for adapters that don't let us observe the response.
 */
export function classifyProviderError(errorMessage: string, observed: { status?: number; body?: string } = {}): TargetError {
  const split = splitProviderErrorMessage(errorMessage);
  const status = observed.status !== undefined && observed.status >= 400 ? observed.status : split.status;
  const defaultType = status !== undefined ? PASSTHROUGH_STATUS_TYPES[status] : undefined;
  if (status === undefined || defaultType === undefined) return gatewayError(errorMessage);

  const fields = (observed.body ? parseProviderErrorBody(observed.body) : null) ?? parseProviderErrorBody(split.rest);
  return {
    status,
    message: fields?.message ?? (split.rest || errorMessage),
    type: fields?.type ?? defaultType,
    ...(fields?.code ? { code: fields.code } : {}),
    ...(fields?.param ? { param: fields.param } : {}),
    failover: !NO_FAILOVER_STATUSES.has(status),
  };
}

/**
 * pi-ai adapters that accept a custom `fetch` (the others ignore it, and
 * the Google ones reject it outright).
 */
const FETCH_OBSERVABLE_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "mistral-conversations",
]);

/** Largest error body kept from an observed response. */
const MAX_OBSERVED_BODY_CHARS = 16_000;

export interface ResponseProbe {
  /** Status and (for non-2xx) body of the last provider HTTP response seen, if any. */
  readonly observed: { status?: number; body?: string };
  /** pi-ai stream options that feed the probe - spread into the request options. */
  readonly options: Pick<StreamOptions, "fetch" | "onResponse">;
}

/**
 * Observes the provider's HTTP responses so a failure can be classified by
 * its real status and body instead of by parsing pi-ai's error text: a
 * wrapping `fetch` where the adapter takes one (the OpenAI and Anthropic
 * SDKs throw on a non-2xx before `onResponse` would run), plus `onResponse`
 * for adapters that report error responses through it (e.g. ChatGPT/Codex).
 */
export function createResponseProbe(api: Api): ResponseProbe {
  const observed: { status?: number; body?: string } = {};
  const onResponse = (response: ProviderResponse) => {
    if (observed.status !== response.status) observed.body = undefined;
    observed.status = response.status;
  };
  if (!FETCH_OBSERVABLE_APIS.has(api)) return { observed, options: { onResponse } };

  const observingFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await globalThis.fetch(input, init);
    observed.status = response.status;
    observed.body = undefined;
    if (!response.ok) {
      try {
        observed.body = (await response.clone().text()).slice(0, MAX_OBSERVED_BODY_CHARS);
      } catch {
        // Body unreadable - classification falls back to the error message.
      }
    }
    return response;
  };
  return { observed, options: { fetch: observingFetch as typeof fetch, onResponse } };
}
