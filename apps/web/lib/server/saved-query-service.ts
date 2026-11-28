/** Local SQL library. Saved profiles get private, atomic files; other connections use memory. */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  MAX_SAVED_LIBRARY_CHARS,
  MAX_SAVED_QUERIES,
  profileIdSchema,
  savedQueryFileSchema,
  type EditSavedQueryRequest,
  type SavedQuery,
  type SavedQuerySummary,
  type SaveQueryRequest,
} from "@datacanvas/shared-types";
import type { ConnectionRegistry } from "./connection-registry";
import type { ProfileService } from "./profile-service";
import { guardStorage, ServiceError } from "./service-error";
import { KeyedMutex, readTextFile, writeFileAtomic } from "./storage/atomic-file";

export class SavedQueryService {
  private readonly session = new Map<string, SavedQuery[]>();
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly connections: ConnectionRegistry,
    private readonly profiles: ProfileService,
    private readonly dataDir: string,
  ) {
    connections.onRemove((id) => this.session.delete(id));
  }

  private scope(connectionId: string) {
    const connection = this.connections.getSummary(connectionId);
    if (!connection) throw new ServiceError("connection_not_found", "This connection is closed.");
    if (!connection.dataAccess) {
      throw new ServiceError("data_access_disabled", "Switch on table data to use saved queries.");
    }
    return connection;
  }

  private file(profileId: string): string {
    return path.join(this.dataDir, "saved-queries", profileIdSchema.parse(profileId) + ".json");
  }

  private async useLibrary<T>(
    connectionId: string,
    work: (queries: SavedQuery[], save: (queries: SavedQuery[]) => Promise<void>) => T | Promise<T>,
  ): Promise<T> {
    const { profileId } = this.scope(connectionId);
    const key = profileId === null ? `connection:${connectionId}` : `profile:${profileId}`;
    return this.mutex.run(key, async () => {
      const connection = this.scope(connectionId);
      if (connection.profileId !== profileId) {
        throw new ServiceError(
          "connection_not_found",
          "The connection changed. Reopen saved queries.",
        );
      }
      if (profileId === null) {
        return work(this.session.get(connectionId) ?? [], async (queries) => {
          this.session.set(connectionId, queries);
        });
      }

      // A profile may have been forgotten while this request was waiting for the file lock.
      const profile = await this.profiles.get(profileId);
      if (
        profile.provider !== connection.provider ||
        profile.host !== connection.host ||
        profile.port !== connection.port ||
        profile.database !== connection.database ||
        profile.username !== connection.username
      ) {
        throw new ServiceError(
          "profile_not_found",
          "Reconnect using the saved connection's details to use its queries.",
        );
      }
      return guardStorage(async () => {
        const file = this.file(profileId);
        const contents = await readTextFile(file);
        const queries =
          contents === null ? [] : savedQueryFileSchema.parse(JSON.parse(contents)).queries;
        return work(queries, (next) =>
          writeFileAtomic(file, JSON.stringify({ version: 1, queries: next })),
        );
      });
    });
  }

  /** Keep concurrent saves out until the profile is gone. A failed file deletion leaves the profile available to retry. */
  forgetProfile(profileId: string, removeProfile: () => Promise<void>): Promise<void> {
    return this.mutex.run(`profile:${profileId}`, async () => {
      await this.profiles.get(profileId);
      await guardStorage(() => rm(this.file(profileId), { force: true }));
      await removeProfile();
    });
  }

  list(connectionId: string): Promise<SavedQuerySummary[]> {
    return this.useLibrary(connectionId, (queries) => summaries(queries));
  }

  get(connectionId: string, id: string): Promise<SavedQuery> {
    return this.useLibrary(connectionId, (queries) => findQuery(queries, id));
  }

  add(connectionId: string, input: SaveQueryRequest): Promise<SavedQuerySummary[]> {
    return this.useLibrary(connectionId, async (queries, save) => {
      requireUnusedName(queries, input.name);
      const next = [{ ...input, id: randomBytes(12).toString("base64url") }, ...queries];
      requireCapacity(next);
      await save(next);
      return summaries(next);
    });
  }

  edit(
    connectionId: string,
    id: string,
    input: EditSavedQueryRequest,
  ): Promise<SavedQuerySummary[]> {
    return this.useLibrary(connectionId, async (queries, save) => {
      const query = findQuery(queries, id);
      if ("name" in input)
        requireUnusedName(
          queries.filter((item) => item.id !== id),
          input.name,
        );
      const next = queries.map((item) => (item.id === id ? { ...query, ...input } : item));
      requireCapacity(next);
      await save(next);
      return summaries(next);
    });
  }

  remove(connectionId: string, id: string): Promise<SavedQuerySummary[]> {
    return this.useLibrary(connectionId, async (queries, save) => {
      const next = queries.filter((item) => item.id !== id);
      if (next.length !== queries.length) await save(next);
      return summaries(next);
    });
  }
}

function summaries(queries: SavedQuery[]): SavedQuerySummary[] {
  return queries.map(({ id, name }) => ({ id, name }));
}

function findQuery(queries: SavedQuery[], id: string): SavedQuery {
  const query = queries.find((item) => item.id === id);
  if (!query) throw new ServiceError("saved_query_not_found", "This saved query no longer exists.");
  return query;
}

function requireUnusedName(queries: SavedQuery[], name: string): void {
  if (queries.some((query) => query.name.toLowerCase() === name.toLowerCase())) {
    throw new ServiceError(
      "saved_query_name_taken",
      "A saved query already has that name. Choose another name.",
    );
  }
}

function requireCapacity(queries: SavedQuery[]): void {
  if (
    queries.length > MAX_SAVED_QUERIES ||
    queries.reduce((size, query) => size + query.text.length, 0) > MAX_SAVED_LIBRARY_CHARS
  ) {
    throw new ServiceError(
      "saved_query_limit",
      "This library is full. Remove a saved query and try again.",
    );
  }
}
