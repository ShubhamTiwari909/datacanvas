/**
 * Remembering the running DataCanvas, so a second `npx datacanvas` opens the
 * first one instead of starting another server.
 *
 * Because every run has a private session token (Phase 10), a second launch
 * cannot just open `http://127.0.0.1:4747`: it would be refused. So the
 * running instance leaves a small file, `run.json`, in the data folder with its
 * port and token, readable by the owner only (mode 0600). The file is deleted
 * on clean shutdown; a leftover from a crash is detected (dead process or no
 * health answer) and ignored.
 *
 * Security note: the token is now also on disk while DataCanvas runs. Anyone
 * who can read this file as the same user could already read the process
 * environment, so the exposure is the same class as before (see
 * docs/threat-model.md).
 */
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface InstanceInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
}

const FILE_NAME = "run.json";

export function instanceFile(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

/** Parse untrusted file content into an InstanceInfo, or null if it is not one. */
export function parseInstance(text: string): InstanceInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { pid, port, token, version } = value as Record<string, unknown>;
  if (!Number.isInteger(pid) || (pid as number) < 1) return null;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  if (typeof version !== "string" || version.length > 64) return null;
  return { pid: pid as number, port: port as number, token, version };
}

export async function writeInstance(dataDir: string, info: InstanceInfo): Promise<void> {
  const file = instanceFile(dataDir);
  await writeFile(file, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  await chmod(file, 0o600); // `mode` is ignored when the file already exists
}

export async function readInstance(dataDir: string): Promise<InstanceInfo | null> {
  try {
    return parseInstance(await readFile(instanceFile(dataDir), "utf8"));
  } catch {
    return null;
  }
}

/** Delete the file, but only if it still describes THIS process (another instance may have replaced it). */
export async function removeInstance(dataDir: string, pid: number): Promise<void> {
  const current = await readInstance(dataDir);
  if (current && current.pid !== pid) return;
  await rm(instanceFile(dataDir), { force: true });
}

/** Is a process with this id alive? (Signal 0 only checks; it sends nothing.) */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, but not ours
  }
}

/**
 * Find a DataCanvas that is really running: the file parses, its process is
 * alive, and the port answers /api/health as DataCanvas.
 */
export async function findRunningInstance(
  dataDir: string,
  check: (port: number) => Promise<boolean>,
): Promise<InstanceInfo | null> {
  const info = await readInstance(dataDir);
  if (!info || !isProcessAlive(info.pid)) return null;
  return (await check(info.port)) ? info : null;
}

/** Ask a port whether it is DataCanvas. Never throws. */
export async function isDataCanvasHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { application?: unknown };
    return body.application === "datacanvas";
  } catch {
    return false;
  }
}
