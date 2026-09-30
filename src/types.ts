export interface ApiKeyRecord {
  id: number;
  name: string;
  keyPrefix: string;
  keyHash: string;
  allowedModels: string[] | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface ModelAliasTarget {
  providerID: string;
  modelID: string;
  variant: string;
}

export type ModelAliasMode = "priority" | "random";

export interface ModelAliasRecord {
  id: number;
  alias: string;
  mode: ModelAliasMode;
  /** Ordered by `position` - for "priority" mode this IS the try order; for "random" mode it's just display order. */
  targets: ModelAliasTarget[];
  /**
   * When true, a client's explicit reasoning effort replaces the targets'
   * pinned levels (mapped/clamped per target); when false (the default) the
   * pinned levels always win.
   */
  clientEffortOverrides: boolean;
  createdAt: string;
}

export interface RequestLogEntry {
  apiKeyId: number | null;
  appName: string;
  /** The model that served the request (for an alias: the target that answered). */
  model: string;
  variant: string | null;
  /** The alias the client asked for, when it did. */
  alias?: string | null;
  /** How the request was served, when noteworthy: failover, ignored client effort, dropped params. */
  notes?: string | null;
  stream: boolean;
  status: "ok" | "error";
  httpStatus: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Included in `completionTokens`. Null on rows logged before this was tracked. */
  reasoningTokens: number | null;
  /** Included in `promptTokens`. Null on rows logged before this was tracked. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  latencyMs: number;
  errorMessage: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

export interface RequestLogRow extends RequestLogEntry {
  id: number;
  createdAt: string;
}
