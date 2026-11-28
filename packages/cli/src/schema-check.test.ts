import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureStructure } from "@datacanvas/database-core";
import { PostgresAdapter } from "@datacanvas/postgres-adapter";
import { createTestDatabase, testDatabaseUrl } from "@datacanvas/postgres-adapter/testing";
import { CURRENT_SNAPSHOT_VERSION, SNAPSHOT_FORMAT } from "@datacanvas/shared-types";
import pg from "pg";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function check(args: string[], url: string) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [cli, "schema", "check", ...args],
        { env: { ...process.env, DATACANVAS_DATABASE_URL: url }, timeout: 15_000 },
        (error, stdout, stderr) => {
          if (error && error.code === undefined) reject(error);
          else resolve({ code: error?.code ?? 0, stdout, stderr });
        },
      );
    },
  );
}

it("rejects missing credentials and malformed baselines with exit 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "datacanvas-schema-"));
  try {
    const file = join(dir, "invalid.snapshot.json");
    await writeFile(file, "{");
    const args = ["--baseline", file, "--format", "json"];
    expect(await check(args, "")).toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("DATACANVAS_DATABASE_URL"),
    });
    expect(await check(args, "postgresql://user:secret@127.0.0.1/db")).toEqual({
      code: 2,
      stdout: "",
      stderr: "Error: The baseline is not valid JSON.\n",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const server = testDatabaseUrl();

it.skipIf(!server)(
  "checks current and older snapshots against real PostgreSQL",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "datacanvas-schema-"));
    try {
      const db = await createTestDatabase();
      try {
        const file = join(dir, "baseline.snapshot.json");
        const adapter = new PostgresAdapter(db.connection);
        await adapter.connect();
        let structure;
        try {
          structure = await captureStructure(adapter, {
            maxTables: 5000,
            maxObjectsPerKind: 10_000,
            schemaBatch: 8,
            detailsBatch: 100,
          });
        } finally {
          await adapter.disconnect();
        }
        const snapshot = {
          format: SNAPSHOT_FORMAT,
          schemaVersion: CURRENT_SNAPSHOT_VERSION,
          id: "snap_schema1234",
          name: "Schema check baseline",
          createdAt: "2026-11-28T00:00:00.000Z",
          source: null,
          structure,
        };
        const url = new URL(server!);
        url.pathname = "/" + db.dbName;
        const jsonArgs = ["--baseline", file, "--format", "json"];
        await writeFile(file, JSON.stringify(snapshot));

        const match = await check(jsonArgs, url.href);
        expect(match).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(match.stdout)).toMatchObject({
          status: "match",
          diff: { isEmpty: true, objectsCompared: true },
        });

        const unavailable = new URL(url);
        unavailable.pathname += "_missing";
        const failure = await check(jsonArgs, unavailable.href);
        expect(failure).toMatchObject({
          code: 2,
          stdout: "",
          stderr: expect.stringContaining("database"),
        });
        expect(failure.stderr).not.toContain(unavailable.href);

        const legacy = join(dir, "old.snapshot.json");
        const { objects: _objects, ddl: _ddl, ...oldStructure } = structure;
        await writeFile(
          legacy,
          JSON.stringify({ ...snapshot, schemaVersion: 1, structure: oldStructure }),
        );
        const incomplete = await check(["--baseline", legacy, "--format", "json"], url.href);
        expect(incomplete).toMatchObject({
          code: 2,
          stderr: expect.stringContaining("lacks object metadata"),
        });
        expect(JSON.parse(incomplete.stdout)).toMatchObject({
          status: "incomplete",
          diff: { isEmpty: true, objectsCompared: false },
        });

        const migration = new pg.Client({ connectionString: url.href });
        await migration.connect();
        try {
          await migration.query("CREATE VIEW public.cli_object_drift AS SELECT 1 AS value");
          const objectDrift = await check(jsonArgs, url.href);
          expect(objectDrift).toMatchObject({ code: 1, stderr: "" });
          expect(JSON.parse(objectDrift.stdout)).toMatchObject({
            status: "drift",
            diff: { summary: { objects: { views: { added: 1 } } } },
          });
          await migration.query("DROP VIEW public.cli_object_drift");
          await migration.query("CREATE TABLE public.cli_drift (id integer PRIMARY KEY)");
        } finally {
          await migration.end();
        }

        const drift = await check(jsonArgs, url.href);
        expect(drift).toMatchObject({ code: 1, stderr: "" });
        expect(JSON.parse(drift.stdout)).toMatchObject({
          status: "drift",
          diff: { summary: { tables: { added: 1 } } },
        });
        const legacyDrift = await check(["--baseline", legacy, "--format", "json"], url.href);
        expect(legacyDrift).toMatchObject({ code: 1, stderr: "" });
        expect(JSON.parse(legacyDrift.stdout)).toMatchObject({
          status: "drift",
          diff: { objectsCompared: false },
        });

        const markdown = await check(["--baseline", file], url.href);
        expect(markdown).toMatchObject({
          code: 1,
          stderr: "",
          stdout: expect.stringContaining("public.cli_drift"),
        });
      } finally {
        await db.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
