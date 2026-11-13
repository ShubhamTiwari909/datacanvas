/**
 * Small, careful file helpers for the data folder.
 *
 * WHY "atomic" writes: writing a file in place is not instant. If the process
 * is killed, the disk fills up or the machine loses power halfway through, the
 * file is left half-written and the user's saved data is corrupt. Instead we
 * write the complete new content to a TEMPORARY file in the same folder, flush
 * it to disk, and then RENAME it over the real file. A rename is a single
 * operation that the file system performs entirely or not at all, so a reader
 * (or a later run) sees either the complete old file or the complete new one,
 * never a mixture.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Create a folder (and its parents) that only the owner can use. A no-op on Windows, where modes are ignored. */
export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

/**
 * Replace `target` with `content`, atomically (see the file header).
 * The file is created readable by its owner only.
 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const directory = path.dirname(target);
  await ensureDirectory(directory);

  // A random name in the SAME folder: rename is only atomic within one file system.
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    // "wx": fail if it exists, so two writers can never share a temporary file.
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync(); // make sure the bytes are on the disk, not just in the OS cache
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {}); // do not leave debris behind
    throw error;
  }
}

/** The file's text, or null if it does not exist. Other problems (permissions...) are thrown. */
export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Run async jobs that share a key one after another.
 *
 * Two requests that update the same file at about the same time must not
 * interleave their "read, change, write" steps, or one update would silently
 * overwrite the other. Jobs with different keys run in parallel. (This protects
 * against other requests in THIS process, which is all that runs: DataCanvas is
 * a single local server.)
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // A failed earlier job must not block the queue, so its rejection is ignored here.
    const current = previous.catch(() => {}).then(work);
    this.tails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
