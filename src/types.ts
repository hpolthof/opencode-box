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
  createdAt: string;
}

export interface RequestLogEntry {
  apiKeyId: number | null;
  appName: string;
  model: string;
  variant: string | null;
  stream: boolean;
  status: "ok" | "error";
  httpStatus: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  errorMessage: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

export interface RequestLogRow extends RequestLogEntry {
  id: number;
  createdAt: string;
}
