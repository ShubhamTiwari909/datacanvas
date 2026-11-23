/**
 * Exporting rows as a file, at the service (decision 158): the data-access check comes first, one export at
 * a time per connection, the file is the formatter's text for the events of the adapter, a file that reaches
 * its size limit stops and says so, and a client that goes away ends the read. The adapter is the mock with
 * its `exportRows` replaced by a script of events; the real reader is tested against PostgreSQL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_MAX_BYTES, type ExportEvent } from "@datacanvas/database-core";
import { exportRequestSchema, postgresConnectionInputSchema } from "@datacanvas/shared-types";
import { createTestContext, fieldsInput, type TestContext } from "./test-support";

const request = (over: Record<string, unknown> = {}) =>
  exportRequestSchema.parse({ schema: "public", table: "t", format: "csv", ...over });

async function connected(): Promise<{ context: TestContext; id: string }> {
  const context = createTestContext();
  const { id } = await context.connections.createConnection(
    postgresConnectionInputSchema.parse(fieldsInput({ dataAccess: true })),
  );
  return { context, id };
}

type Script = (sink: (e: ExportEvent) => unknown, signal?: { aborted: boolean }) => Promise<void>;
function script(context: TestContext, run: Script): void {
  vi.spyOn(context.createdAdapters[0]!, "exportRows").mockImplementation(
    async (_table, _options, sink, signal) => run(sink as (e: ExportEvent) => unknown, signal),
  );
}
const columns = [
  { name: "id", dataType: "integer" },
  { name: "note", dataType: "text" },
];
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

afterEach(() => vi.restoreAllMocks());

describe("ConnectionService.exportRows", () => {
  it("refuses before touching the database when data access is off, and for an unknown connection", async () => {
    const context = createTestContext();
    const { id } = await context.connections.createConnection(
      postgresConnectionInputSchema.parse(fieldsInput()),
    );
    const spy = vi.spyOn(context.createdAdapters[0]!, "exportRows");
    await expect(context.connections.exportRows(id, request())).rejects.toMatchObject({
      code: "data_access_disabled",
    });
    await expect(context.connections.exportRows("missing", request())).rejects.toMatchObject({
      code: "connection_not_found",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("streams the file: a byte order mark and the header for CSV, the rows, and the cut at the end", async () => {
    const { context, id } = await connected();
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: ["password"] });
      await sink({
        kind: "rows",
        rows: [
          ["1", "=1+1"],
          ["2", null],
        ],
        cellsCut: 0,
      });
      await sink({ kind: "end", rows: 2, cut: "rows", cellsCut: 0 });
    });
    const { stream, contentType } = await context.connections.exportRows(id, request());
    expect(contentType).toBe("text/csv; charset=utf-8");
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    // A byte order mark first (a text decoder would hide it), so a spreadsheet guesses UTF-8.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const file = new TextDecoder().decode(bytes);
    expect(file.startsWith("id,note\r\n")).toBe(true);
    expect(file).toContain("1,'=1+1\r\n");
    expect(file).toContain("2,\r\n");
    expect(file).toContain("# This file was cut at the limit of 100,000 rows.");
  });

  it("writes JSON as an object with the notes, and names the columns that were left out and the conditions without values", async () => {
    const { context, id } = await connected();
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: ["token"] });
      await sink({ kind: "rows", rows: [["1", "a"]], cellsCut: 0 });
      await sink({ kind: "end", rows: 1, cut: null, cellsCut: 0 });
    });
    const secret = "hunter2-SECRET-VALUE";
    const { stream } = await context.connections.exportRows(
      id,
      request({ format: "json", filters: [{ column: "note", op: "contains", value: secret }] }),
    );
    const file = await text(stream);
    expect(JSON.parse(file)._meta).toMatchObject({
      rows: 1,
      columnsLeftOut: ["token"],
      filters: ["note contains"],
    });
    expect(file).not.toContain(secret);
  });

  it("answers an error that is known before the first byte, and lets the next export start", async () => {
    const { context, id } = await connected();
    script(context, async () => {
      throw Object.assign(new Error("x"), { name: "DatabaseError", code: "invalid_request" });
    });
    await expect(context.connections.exportRows(id, request())).rejects.toMatchObject({
      code: "invalid_request",
    });
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await sink({ kind: "end", rows: 0, cut: null, cellsCut: 0 });
    });
    const { stream } = await context.connections.exportRows(id, request({ format: "ndjson" }));
    expect(await text(stream)).toBe("");
  });

  it("runs one export at a time per connection, and frees it when the file is done", async () => {
    const { context, id } = await connected();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await held;
      await sink({ kind: "end", rows: 0, cut: null, cellsCut: 0 });
    });
    const first = await context.connections.exportRows(id, request());
    await expect(context.connections.exportRows(id, request())).rejects.toMatchObject({
      code: "export_busy",
    });
    release();
    await text(first.stream);
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await sink({ kind: "end", rows: 0, cut: null, cellsCut: 0 });
    });
    const again = await context.connections.exportRows(id, request());
    await text(again.stream);
  });

  it("tells the adapter to stop when the file reaches its size limit", async () => {
    const { context, id } = await connected();
    const big = "x".repeat(1_000_000);
    let answers: unknown[] = [];
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      const rows = Array.from({ length: 40 }, (_, i) => [String(i), big]);
      // The first batch fits; the second would pass the limit, so it is left out whole and the answer is "stop".
      answers = [
        await sink({ kind: "rows", rows, cellsCut: 0 }),
        await sink({ kind: "rows", rows, cellsCut: 0 }),
      ];
      await sink({ kind: "end", rows: 40, cut: "bytes", cellsCut: 0 });
    });
    const { stream } = await context.connections.exportRows(id, request({ format: "ndjson" }));
    const file = await text(stream);
    expect(answers).toEqual([true, false]);
    // The file never grows past the limit by a batch.
    expect(file.length).toBeLessThanOrEqual(EXPORT_MAX_BYTES);
    expect(file.length).toBeGreaterThan(40_000_000);
    expect(JSON.parse(file.trimEnd().split("\n").pop()!)._meta.cut).toBe("bytes");
  }, 60_000);

  it("ends the read when the client goes away, and frees the connection", async () => {
    const { context, id } = await connected();
    let failure: unknown = null;
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      try {
        for (let i = 0; i < 1000; i++) {
          await sink({ kind: "rows", rows: [[String(i), "x".repeat(10_000)]], cellsCut: 0 });
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    const { stream } = await context.connections.exportRows(id, request());
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(failure).not.toBeNull());
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await sink({ kind: "end", rows: 0, cut: null, cellsCut: 0 });
    });
    await vi.waitFor(async () => {
      const again = await context.connections.exportRows(id, request());
      await text(again.stream);
    });
  });

  it("ends a stream that fails after the first byte with a fixed sentence, never the database's error or its cause", async () => {
    const { context, id } = await connected();
    const secret = "SECRET-ROW-VALUE-9f3a";
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await sink({ kind: "rows", rows: [["1", "a"]], cellsCut: 0 });
      throw new Error("unexpected", {
        cause: new Error(`invalid input syntax for type integer: "${secret}"`),
      });
    });
    const { stream } = await context.connections.exportRows(id, request());
    let failure: unknown = null;
    try {
      await text(stream);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const chain: string[] = [];
    for (
      let e = failure as { message?: string; cause?: unknown } | undefined;
      e;
      e = e.cause as typeof e
    ) {
      chain.push(String(e.message));
    }
    expect(chain).toEqual(["The export stopped before the end of the file."]);
    expect(chain.join(" ")).not.toContain(secret);
  });

  it("gives up an export whose reader stopped, and frees the connection", async () => {
    const context = createTestContext({}, { exportStallMs: 50 });
    const { id } = await context.connections.createConnection(
      postgresConnectionInputSchema.parse(fieldsInput({ dataAccess: true })),
    );
    let failure: unknown = null;
    script(context, async (sink) => {
      try {
        await sink({ kind: "start", columns, leftOut: [] });
        // Nobody reads the stream: a write must not wait for ever.
        for (let i = 0; i < 100; i++) {
          await sink({ kind: "rows", rows: [[String(i), "x".repeat(1000)]], cellsCut: 0 });
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    await context.connections.exportRows(id, request());
    await vi.waitFor(() => expect(failure).not.toBeNull());
    expect(String((failure as Error).message)).toMatch(/stopped receiving/);
    script(context, async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await sink({ kind: "end", rows: 0, cut: null, cellsCut: 0 });
    });
    await vi.waitFor(async () => {
      const again = await context.connections.exportRows(id, request());
      await text(again.stream);
    });
  });
});
