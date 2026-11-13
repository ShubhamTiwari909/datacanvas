/**
 * `connections.json`: the saved connection profiles. Contains NO passwords.
 */
import {
  emptyConnectionsFile,
  MAX_PROFILES,
  parseConnectionsFile,
  type ConnectionProfile,
  type ConnectionsFile,
} from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { guardStorage, ServiceError } from "../service-error";
import { KeyedMutex, readTextFile, writeFileAtomic } from "./atomic-file";

export class ProfileStorage {
  private readonly file: string;
  private readonly mutex = new KeyedMutex();

  constructor(directory: string) {
    this.file = path.join(directory, "connections.json");
  }

  list(): Promise<ConnectionProfile[]> {
    return guardStorage(async () => (await this.read()).profiles);
  }

  /** Add a profile. @throws ServiceError `storage_error` if the limit is reached or the disk fails. */
  add(profile: ConnectionProfile): Promise<void> {
    return this.update((file) => {
      if (file.profiles.length >= MAX_PROFILES) {
        throw new ServiceError(
          "storage_error",
          `At most ${MAX_PROFILES} connections can be saved. Forget one first.`,
        );
      }
      return { ...file, profiles: [...file.profiles, profile] };
    });
  }

  /** Remove a profile. Returns false if there was no such profile. */
  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.update((file) => {
      removed = file.profiles.some((p) => p.id === id);
      return { ...file, profiles: file.profiles.filter((p) => p.id !== id) };
    });
    return removed;
  }

  /** Read-modify-write, one at a time, so concurrent changes cannot overwrite each other. */
  private update(change: (file: ConnectionsFile) => ConnectionsFile): Promise<void> {
    return guardStorage(() =>
      this.mutex.run(this.file, async () => {
        const next = change(await this.read());
        await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      }),
    );
  }

  /**
   * Load the file. A missing file means "no profiles yet". A DAMAGED file is
   * moved aside (never deleted, never overwritten) and we start fresh, so a
   * corrupt file cannot block the feature or silently destroy what is in it.
   */
  private async read(): Promise<ConnectionsFile> {
    const text = await readTextFile(this.file);
    if (text === null) return emptyConnectionsFile();

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = parseConnectionsFile(raw);
    if (parsed.ok) return parsed.file;

    // Do not move aside a file that is merely from a NEWER release: refuse instead.
    if (raw !== undefined && /newer version/.test(parsed.message)) {
      throw new ServiceError("storage_error", parsed.message);
    }
    const aside = path.join(path.dirname(this.file), `connections.damaged-${Date.now()}.json`);
    await fs.rename(this.file, aside);
    console.error(
      "[datacanvas] connections.json was damaged; it was moved aside and a new one started.",
    );
    return emptyConnectionsFile();
  }
}
