/**
 * Where DataCanvas keeps its files.
 *
 *   ~/.datacanvas/                      (the user's home folder, any operating system)
 *   ├── connections.json                saved connection profiles (NO passwords)
 *   └── workspaces/<id>.json            one file per saved canvas layout
 *
 * `DATACANVAS_HOME` overrides the location (used by tests, and handy for
 * keeping a separate set of data). It is optional and never required.
 *
 * Nothing in this folder is a secret, but schema names can be sensitive, so the
 * folder is created readable by the owner only (see `ensureDirectory`).
 */
import os from "node:os";
import path from "node:path";

export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const override = env.DATACANVAS_HOME?.trim();
  return override ? path.resolve(override) : path.join(home, ".datacanvas");
}
