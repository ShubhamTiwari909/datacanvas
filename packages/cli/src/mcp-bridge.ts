/**
 * `datacanvas mcp`: a stdio bridge between a Claude app and the running DataCanvas (`docs/mcp-server-plan.md`, section 5.3).
 *
 * Claude Desktop (and Claude Code, when it is told to) starts a COMMAND and talks to it over stdio: one JSON-RPC message
 * per line in, one per line out. The bridge forwards each line to `POST /mcp` of the running DataCanvas with the MCP token
 * it reads from `mcp.json` on every message (the token changes at every run, so the config of the Claude app never has to).
 * It has no dependency, holds no secret of its own and keeps no state; if DataCanvas is not running it answers a JSON-RPC
 * error in plain words.
 *
 * Nothing but protocol goes to stdout (a stray line would break the client); notes for a person go to stderr.
 */
import { createInterface } from "node:readline";
import { readMcpFile } from "./mcp-file.js";

const NOT_RUNNING =
  "DataCanvas is not running, or no connection is shared with Claude. Start DataCanvas, connect to your database and switch on Share with Claude.";

/** The most characters of one line the bridge forwards (the endpoint refuses more than 256 KB anyway). */
export const MAX_LINE_CHARS = 300_000;

function errorLine(id: unknown, message: string, code = -32000): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** The id of a message, when it has one that is a string or a number. */
function idOf(text: string): string | number | null {
  try {
    const value = JSON.parse(text) as { id?: unknown };
    return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
  } catch {
    return null;
  }
}

/**
 * Forward one line and say what to write back (null: nothing, because the message was a notification).
 * `fetchImpl` is a parameter for the tests.
 */
export async function forwardLine(
  dataDir: string,
  line: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const id = idOf(line);
  if (line.length > MAX_LINE_CHARS) return errorLine(id, "That message is too large.", -32600);
  const file = await readMcpFile(dataDir);
  if (!file) return id === null ? null : errorLine(id, NOT_RUNNING);
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${file.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${file.token}`,
      },
      body: line,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return id === null ? null : errorLine(id, NOT_RUNNING);
  }
  // 202: a notification was accepted, there is nothing to answer.
  if (response.status === 202) return null;
  if (response.status === 404) return id === null ? null : errorLine(id, NOT_RUNNING);
  if (response.status === 401 || response.status === 403) {
    return id === null
      ? null
      : errorLine(
          id,
          "DataCanvas refused this program. Restart DataCanvas and the Claude app, then try again.",
        );
  }
  const text = await response.text();
  // The answer is one JSON value: put it on one line (JSON.stringify never writes a raw line break).
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return id === null ? null : errorLine(id, "DataCanvas sent an answer that is not JSON.");
  }
}

/** Read lines from stdin until it closes; write each answer to stdout. */
export async function runBridge(
  dataDir: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: { write(text: string): unknown } = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Messages are handled one after the other, in order: an answer never overtakes the one before it.
  let chain = Promise.resolve();
  for await (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    chain = chain.then(async () => {
      const answer = await forwardLine(dataDir, line);
      if (answer !== null) output.write(`${answer}\n`);
    });
  }
  await chain;
}
