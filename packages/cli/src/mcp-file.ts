/**
 * `mcp.json`: where the running DataCanvas leaves the port and the MCP token for the stdio bridge `datacanvas mcp`
 * (`docs/mcp-server-plan.md`, section 5.3; decision 169). The bridge starts when a Claude app starts it, long after DataCanvas
 * was launched, and the token changes on every run, so it cannot be in the Claude app's config: it is read from here on
 * every message.
 *
 * It is the same class of file as `run.json` (mode 0600, deleted on a clean shutdown, a leftover from a crash is useless
 * because the token dies with the process), and it holds ONLY what the bridge needs. It is a DIFFERENT secret from the
 * session token of the browser: this one is accepted on `/mcp` and nowhere else, the session token is refused there.
 */
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface McpFile {
  pid: number;
  port: number;
  token: string;
}

const FILE_NAME = "mcp.json";

export const mcpFile = (dataDir: string): string => path.join(dataDir, FILE_NAME);

/** Untrusted file content to a `McpFile`, or null when it is not one. */
export function parseMcpFile(text: string): McpFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { pid, port, token } = value as Record<string, unknown>;
  if (!Number.isInteger(pid) || (pid as number) < 1) return null;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return { pid: pid as number, port: port as number, token };
}

export async function writeMcpFile(dataDir: string, info: McpFile): Promise<void> {
  const file = mcpFile(dataDir);
  await writeFile(file, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  await chmod(file, 0o600); // `mode` is ignored when the file already exists
}

export async function readMcpFile(dataDir: string): Promise<McpFile | null> {
  try {
    return parseMcpFile(await readFile(mcpFile(dataDir), "utf8"));
  } catch {
    return null;
  }
}

/** Delete the file, but only if it still describes THIS process (another instance may have replaced it). */
export async function removeMcpFile(dataDir: string, pid: number): Promise<void> {
  const current = await readMcpFile(dataDir);
  if (current && current.pid !== pid) return;
  await rm(mcpFile(dataDir), { force: true });
}
