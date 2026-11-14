/**
 * `snapshots/<id>.json`: one file per saved structure snapshot.
 *
 * Same rules as the workspace files: owner-only permissions (the folder is
 * created with mode 0700 and each file 0600, see atomic-file.ts), atomic
 * writes, ids that can never be a path, damaged files skipped and left alone.
 */
import { parseSnapshotFile, snapshotIdSchema, type Snapshot } from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { guardStorage, ServiceError } from "../service-error";
import { KeyedMutex, readTextFile, writeFileAtomic } from "./atomic-file";

export class SnapshotStorage {
  private readonly directory: string;
  private readonly mutex = new KeyedMutex();

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "snapshots");
  }

  /**
   * The file for an id, or null if the id is not a valid id.
   *
   * SECURITY: the only place an id becomes a path. The id pattern allows no
   * path characters, so the result is always directly inside `snapshots/`.
   */
  private fileFor(id: string): string | null {
    return snapshotIdSchema.safeParse(id).success ? path.join(this.directory, `${id}.json`) : null;
  }

  /** Every readable snapshot. Damaged files are skipped (and counted), never deleted. */
  list(): Promise<{ snapshots: Snapshot[]; skipped: number }> {
    return guardStorage(async () => {
      let names: string[];
      try {
        names = await fs.readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { snapshots: [], skipped: 0 };
        throw error;
      }
      const snapshots: Snapshot[] = [];
      let skipped = 0;
      // Only "<id>.json"; temporary files from an interrupted write start with "." and are ignored.
      for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith("."))) {
        const text = await readTextFile(path.join(this.directory, name));
        const snapshot = text === null ? null : this.parse(text);
        if (snapshot) snapshots.push(snapshot);
        else skipped += 1;
      }
      return { snapshots, skipped };
    });
  }

  /**
   * One snapshot, or null if there is none.
   * @throws ServiceError `invalid_snapshot_file` if the file exists but is damaged.
   */
  get(id: string): Promise<Snapshot | null> {
    const file = this.fileFor(id);
    if (!file) return Promise.resolve(null);
    return guardStorage(async () => {
      const text = await readTextFile(file);
      if (text === null) return null;
      const snapshot = this.parse(text);
      if (!snapshot) {
        throw new ServiceError(
          "invalid_snapshot_file",
          "This snapshot file is damaged and cannot be opened.",
        );
      }
      return snapshot;
    });
  }

  put(snapshot: Snapshot): Promise<void> {
    const file = this.fileFor(snapshot.id);
    if (!file) {
      return Promise.reject(
        new ServiceError("snapshot_not_found", "This snapshot does not exist."),
      );
    }
    return guardStorage(() =>
      this.mutex.run(file, () => writeFileAtomic(file, `${JSON.stringify(snapshot)}\n`)),
    );
  }

  /** Delete a snapshot. Returns false if it did not exist. */
  remove(id: string): Promise<boolean> {
    const file = this.fileFor(id);
    if (!file) return Promise.resolve(false);
    return guardStorage(() =>
      this.mutex.run(file, async () => {
        try {
          await fs.unlink(file);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }),
    );
  }

  private parse(text: string): Snapshot | null {
    try {
      const parsed = parseSnapshotFile(JSON.parse(text));
      return parsed.ok ? parsed.snapshot : null;
    } catch {
      return null;
    }
  }
}
