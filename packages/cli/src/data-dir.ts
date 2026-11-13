/**
 * The folder where DataCanvas keeps its files (`~/.datacanvas`, or the folder in
 * `DATACANVAS_HOME`). The web app resolves the same path in
 * `apps/web/lib/server/storage/data-dir.ts`; `tests/data-dir.test.ts` fails if
 * the two ever disagree. (The CLI is bundled on its own and cannot import the
 * web app, so the few lines are repeated on purpose.)
 */
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const override = env.DATACANVAS_HOME?.trim();
  return override ? path.resolve(override) : path.join(home, ".datacanvas");
}

/**
 * Create the data folder if it is missing (owner-only: schema names can be
 * sensitive). Returns true when it was created now, i.e. on the first run.
 */
export async function ensureDataDir(dir: string): Promise<boolean> {
  const existed = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!existed) await mkdir(dir, { recursive: true, mode: 0o700 });
  return !existed;
}
