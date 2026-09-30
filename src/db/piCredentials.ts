import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { db } from "./client";

/**
 * pi-ai `CredentialStore` backed by the gateway's SQLite database, so OAuth
 * logins done from the dashboard survive restarts. `modify` calls for the
 * same provider are chained so a token refresh and a concurrent request
 * never read-modify-write over each other (single process, so an
 * in-memory queue per provider is enough).
 */
export class SqliteCredentialStore implements CredentialStore {
  private chains = new Map<string, Promise<unknown>>();

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    const row = db
      .query<{ credential: string }, [string]>("SELECT credential FROM pi_credentials WHERE provider_id = ?")
      .get(providerId);
    return row ? (JSON.parse(row.credential) as Credential) : undefined;
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return db
      .query<{ provider_id: string; credential: string }, []>("SELECT provider_id, credential FROM pi_credentials ORDER BY provider_id")
      .all()
      .map((row) => ({ providerId: row.provider_id, type: (JSON.parse(row.credential) as Credential).type }));
  }

  /** Same semantics as pi-ai's InMemoryCredentialStore: returning undefined from `fn` keeps the current credential. */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      db.query(
        `INSERT INTO pi_credentials (provider_id, credential, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(provider_id) DO UPDATE SET credential = excluded.credential, updated_at = excluded.updated_at`
      ).run(providerId, JSON.stringify(next));
      return next;
    });
  }

  delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(providerId, async () => {
      db.query("DELETE FROM pi_credentials WHERE provider_id = ?").run(providerId);
    });
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(task);
    const tail = queued.catch(() => {});
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return queued;
  }
}
