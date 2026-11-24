import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { forwardLine, MAX_LINE_CHARS, runBridge } from "./mcp-bridge.js";
import { mcpFile, parseMcpFile, readMcpFile, removeMcpFile, writeMcpFile } from "./mcp-file.js";
import { MCP_TOKEN_ENV, buildServerEnv } from "./web-server.js";

const TOKEN = "m".repeat(43);

describe("the token of /mcp in the server's environment", () => {
  it("is given to the server when the CLI made one, and is never the session token's variable", () => {
    const env = buildServerEnv(4747, "s".repeat(43), {}, { mcpToken: TOKEN });
    expect(env[MCP_TOKEN_ENV]).toBe(TOKEN);
    expect(env["DATACANVAS_SESSION_TOKEN"]).toBe("s".repeat(43));
    expect(buildServerEnv(4747, "s".repeat(43), {})[MCP_TOKEN_ENV]).toBeUndefined();
  });

  it("drops one inherited from the shell, in every spelling (Windows names are case-insensitive)", () => {
    const base = { [MCP_TOKEN_ENV]: "from-the-shell", datacanvas_mcp_token: "x", PATH: "/bin" };
    const env = buildServerEnv(4747, "s".repeat(43), base);
    expect(Object.keys(env).filter((k) => k.toLowerCase() === MCP_TOKEN_ENV.toLowerCase())).toEqual(
      [],
    );
    expect(env["PATH"]).toBe("/bin");
    expect(buildServerEnv(4747, "s".repeat(43), base, { mcpToken: TOKEN })[MCP_TOKEN_ENV]).toBe(
      TOKEN,
    );
  });
});

describe("mcp.json", () => {
  it("is written for the owner only, read back, and removed only by the process it describes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dc-mcp-"));
    await writeMcpFile(dir, { pid: 4242, port: 4747, token: TOKEN });
    if (process.platform !== "win32") expect((await stat(mcpFile(dir))).mode & 0o777).toBe(0o600);
    expect(await readMcpFile(dir)).toEqual({ pid: 4242, port: 4747, token: TOKEN });
    // It holds the MCP token, port and pid, and nothing else (not the session token).
    expect(Object.keys(JSON.parse(await readFile(mcpFile(dir), "utf8"))).sort()).toEqual([
      "pid",
      "port",
      "token",
    ]);
    await removeMcpFile(dir, 1);
    expect(await readMcpFile(dir)).not.toBeNull();
    await removeMcpFile(dir, 4242);
    expect(await readMcpFile(dir)).toBeNull();
  });

  it("is not trusted: anything that is not a pid, a port and a token is refused", () => {
    for (const text of [
      "",
      "null",
      "[]",
      "{}",
      '{"pid":0,"port":4747,"token":"' + TOKEN + '"}',
      '{"pid":1,"port":70000,"token":"' + TOKEN + '"}',
      '{"pid":1,"port":4747,"token":"short"}',
      '{"pid":1,"port":4747,"token":"' + "!".repeat(43) + '"}',
      "not json",
    ]) {
      expect(parseMcpFile(text), text).toBeNull();
    }
  });
});

describe("the bridge", () => {
  const dirWith = async (file = true) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dc-bridge-"));
    if (file) await writeMcpFile(dir, { pid: 1, port: 4747, token: TOKEN });
    return dir;
  };
  const answerWith = (status: number, body = "") =>
    vi.fn(
      async () => new Response(body === "" ? null : body, { status }),
    ) as unknown as typeof fetch;

  it("forwards a line to /mcp with the bearer token from the file, and answers with one line", async () => {
    const dir = await dirWith();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(init?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
      return new Response('{\n "jsonrpc": "2.0",\n "id": 1,\n "result": {}\n}', { status: 200 });
    }) as unknown as typeof fetch;
    const out = await forwardLine(dir, '{"jsonrpc":"2.0","id":1,"method":"ping"}', fetchImpl);
    expect(out).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toBe("http://127.0.0.1:4747/mcp");
  });

  it("says nothing for a notification, and 'start DataCanvas' in plain words for a request, when DataCanvas is not running", async () => {
    const none = await dirWith(false);
    expect(
      await forwardLine(none, '{"jsonrpc":"2.0","method":"notifications/initialized"}'),
    ).toBeNull();
    const refused = JSON.parse(
      (await forwardLine(none, '{"jsonrpc":"2.0","id":"a","method":"ping"}'))!,
    );
    expect(refused).toMatchObject({
      jsonrpc: "2.0",
      id: "a",
      error: { message: expect.stringMatching(/Start DataCanvas/) },
    });
    const dir = await dirWith();
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      JSON.parse((await forwardLine(dir, '{"jsonrpc":"2.0","id":2,"method":"ping"}', down))!).error
        .message,
    ).toMatch(/not running/);
  });

  it("maps 404 (nothing shared), 401 and 403, and 202, to words or to silence", async () => {
    const dir = await dirWith();
    const request = '{"jsonrpc":"2.0","id":3,"method":"tools/list"}';
    expect(JSON.parse((await forwardLine(dir, request, answerWith(404)))!).error.message).toMatch(
      /Share with Claude/,
    );
    expect(JSON.parse((await forwardLine(dir, request, answerWith(401)))!).error.message).toMatch(
      /refused/,
    );
    expect(JSON.parse((await forwardLine(dir, request, answerWith(403)))!).error.message).toMatch(
      /refused/,
    );
    expect(
      await forwardLine(
        dir,
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        answerWith(202),
      ),
    ).toBeNull();
  });

  it("refuses a line that is too large without sending it, and never writes anything but a JSON line", async () => {
    const dir = await dirWith();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const huge =
      '{"jsonrpc":"2.0","id":9,"method":"x","params":{"a":"' + "x".repeat(MAX_LINE_CHARS) + '"}}';
    const out = JSON.parse((await forwardLine(dir, huge, fetchImpl))!);
    expect(out).toMatchObject({ id: 9, error: { code: -32600 } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        (await forwardLine(
          dir,
          '{"jsonrpc":"2.0","id":4,"method":"ping"}',
          answerWith(200, "<html>"),
        ))!,
      ).error.message,
    ).toMatch(/not JSON/);
  });

  it("reads lines from stdin in order and writes one line for each answer", async () => {
    const dir = await dirWith();
    const { Readable } = await import("node:stream");
    const written: string[] = [];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        calls.push(String(init?.body));
        const id = (JSON.parse(String(init?.body)) as { id?: number }).id;
        return id === undefined
          ? new Response(null, { status: 202 })
          : new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), { status: 200 });
      }),
    );
    try {
      await runBridge(
        dir,
        Readable.from([
          '{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
        ]),
        { write: (text) => written.push(text) },
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toHaveLength(3);
    expect(written).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}\n',
      '{"jsonrpc":"2.0","id":2,"result":{}}\n',
    ]);
  });
});
