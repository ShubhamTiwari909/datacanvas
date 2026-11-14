/**
 * Saved structure snapshots: take, list, load, delete, export and import.
 *
 * A snapshot is captured HERE, on the server, from what the adapter reads, and
 * never taken from the browser's word: the browser only says "snapshot this
 * connection" and gives an optional name. Imported files are untrusted and go
 * through the same validation as files read from disk, and get a NEW id (an
 * import never overwrites anything).
 */
import {
  CURRENT_SNAPSHOT_VERSION,
  MAX_SNAPSHOTS,
  SNAPSHOT_FORMAT,
  parseSnapshotFile,
  summarizeSnapshot,
  type CreateSnapshotInput,
  type Snapshot,
  type SnapshotSummary,
} from "@datacanvas/shared-types";
import { randomBytes } from "node:crypto";
import type { ConnectionService } from "./connection-service";
import { ServiceError } from "./service-error";
import { KeyedMutex } from "./storage/atomic-file";
import type { SnapshotStorage } from "./storage/snapshot-storage";

export interface SnapshotServiceDependencies {
  snapshots: SnapshotStorage;
  connections: Pick<ConnectionService, "captureStructure">;
  now?: () => Date;
}

/** A file name for an exported snapshot: letters, digits and a few safe symbols only. */
export function snapshotFileName(snapshotName: string): string {
  const safe = snapshotName
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .slice(0, 60);
  return `${safe === "" ? "snapshot" : safe}.snapshot.json`;
}

/** "shop 2026-11-14 10:30": the name given when the user does not choose one. */
export function defaultSnapshotName(database: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace("T", " ");
  return `${database} ${stamp}`.slice(0, 100);
}

export class SnapshotService {
  private readonly snapshots: SnapshotStorage;
  private readonly connections: Pick<ConnectionService, "captureStructure">;
  private readonly now: () => Date;
  /**
   * Makes "is there room?" and "write" one step. Without it, several requests at
   * once could all see room for one more and all write, going over the limit.
   */
  private readonly roomLock = new KeyedMutex();

  constructor(dependencies: SnapshotServiceDependencies) {
    this.snapshots = dependencies.snapshots;
    this.connections = dependencies.connections;
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Summaries, newest first. */
  async list(): Promise<SnapshotSummary[]> {
    const { snapshots } = await this.snapshots.list();
    return snapshots.map(summarizeSnapshot).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** @throws ServiceError `snapshot_not_found`, or `invalid_snapshot_file` for a damaged file. */
  async get(id: string): Promise<Snapshot> {
    const snapshot = await this.snapshots.get(id);
    if (!snapshot) throw new ServiceError("snapshot_not_found", "This snapshot does not exist.");
    return snapshot;
  }

  /**
   * Take a snapshot of a live connection and keep it.
   * @throws ServiceError `connection_not_found`, `snapshot_too_large`, `snapshot_limit_reached`
   */
  async create(connectionId: string, input: CreateSnapshotInput): Promise<SnapshotSummary> {
    // A quick early check, so a full store fails BEFORE the (possibly slow) read of the database.
    // It is checked again, under the lock, right before writing.
    await this.requireRoom();
    const { structure, source } = await this.connections.captureStructure(connectionId);
    const at = this.now();
    const snapshot: Snapshot = {
      format: SNAPSHOT_FORMAT,
      schemaVersion: CURRENT_SNAPSHOT_VERSION,
      id: randomBytes(12).toString("base64url"),
      name: input.name ?? defaultSnapshotName(source.database, at),
      createdAt: at.toISOString(),
      source,
      structure,
    };
    await this.putIfRoom(snapshot);
    return summarizeSnapshot(snapshot);
  }

  /** @throws ServiceError `snapshot_not_found` */
  async remove(id: string): Promise<void> {
    if (!(await this.snapshots.remove(id))) {
      throw new ServiceError("snapshot_not_found", "This snapshot does not exist.");
    }
  }

  /** The file content to hand to the user, and a safe name for it. */
  async exportFile(id: string): Promise<{ fileName: string; content: Snapshot }> {
    const snapshot = await this.get(id);
    return { fileName: snapshotFileName(snapshot.name), content: snapshot };
  }

  /**
   * Import a snapshot from the content of an exported file (untrusted JSON):
   * upgraded, validated, saved under a NEW id.
   * @throws ServiceError `invalid_snapshot_file`, `snapshot_limit_reached`
   */
  async importFile(raw: unknown): Promise<SnapshotSummary> {
    const parsed = parseSnapshotFile(raw);
    if (!parsed.ok) throw new ServiceError("invalid_snapshot_file", parsed.message);
    const snapshot: Snapshot = { ...parsed.snapshot, id: randomBytes(12).toString("base64url") };
    await this.putIfRoom(snapshot);
    return summarizeSnapshot(snapshot);
  }

  /** Check the limit and write, as one step. @throws ServiceError `snapshot_limit_reached` */
  private putIfRoom(snapshot: Snapshot): Promise<void> {
    return this.roomLock.run("room", async () => {
      await this.requireRoom();
      await this.snapshots.put(snapshot);
    });
  }

  private async requireRoom(): Promise<void> {
    const { snapshots } = await this.snapshots.list();
    if (snapshots.length >= MAX_SNAPSHOTS) {
      throw new ServiceError(
        "snapshot_limit_reached",
        `At most ${MAX_SNAPSHOTS} snapshots can be saved. Delete some first.`,
      );
    }
  }
}
