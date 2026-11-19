/**
 * Every exported format, run as a runner would run it, on a real PostgreSQL with `psql`: the
 * migration changes the starting database into the target, and the rollback file runs. The runners
 * themselves are not installed here; what each does is done by hand (cut the file at its markers,
 * and run it in one transaction unless it asked for none), so this checks that the TEXT is right.
 * Skipped without a database or without `psql`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildExport,
  planMigration,
  type ExportFormat,
  type ExportFile,
} from "@datacanvas/database-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPair,
  describeDifferences,
  disposePair,
  executeSql,
  readStructure,
  type Pair,
} from "./testing/round-trip.js";
import { testDatabaseUrl } from "./testing/index.js";

const hasPsql = spawnSync("psql", ["--version"]).status === 0;
let pair: Pair;
let dir: string;
let counter = 0;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function psql(db: Pair["from"], text: string, singleTransaction: boolean): void {
  const file = path.join(dir, `run-${++counter}.sql`);
  writeFileSync(file, text);
  const { host, port, username, password } = db.connection;
  const result = spawnSync(
    "psql",
    [
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      ...(singleTransaction ? ["--single-transaction"] : []),
      "-h",
      host,
      "-p",
      String(port),
      "-U",
      username,
      "-d",
      db.dbName,
      "-f",
      file,
    ],
    { env: { ...process.env, PGPASSWORD: password }, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed (${result.status}): ${result.stderr}\n--- file:\n${text}`);
  }
}

/** What a runner would run for each direction, and whether it would wrap it in a transaction. */
function asRunnerWould(format: ExportFormat, files: ExportFile[]) {
  const [first, second] = files;
  const between = (text: string, start: RegExp, end: RegExp | null) => {
    const lines = text.split("\n");
    const from = lines.findIndex((l) => start.test(l));
    const to = end ? lines.findIndex((l, i) => i > from && end.test(l)) : lines.length;
    return lines.slice(from + 1, to < 0 ? lines.length : to).join("\n");
  };
  switch (format) {
    case "sql":
      return { up: first!.content, upTx: false, down: null, downTx: false };
    case "updown":
      return { up: first!.content, upTx: false, down: second!.content, downTx: false };
    case "dbmate": {
      const text = first!.content;
      return {
        up: between(text, /^-- migrate:up/, /^-- migrate:down$/),
        upTx: !/^-- migrate:up transaction:false/m.test(text),
        down: between(text, /^-- migrate:down$/, null),
        downTx: true,
      };
    }
    case "goose": {
      const text = first!.content;
      const tx = !/^-- \+goose NO TRANSACTION$/m.test(text);
      return {
        up: between(text, /^-- \+goose Up$/, /^-- \+goose Down$/),
        upTx: tx,
        down: between(text, /^-- \+goose Down$/, null),
        downTx: tx,
      };
    }
    case "flyway":
      return {
        up: first!.content,
        upTx: !/cannot run this inside a transaction block/.test(first!.content),
        down: second!.content,
        downTx: true,
      };
  }
}

describe.skipIf(!testDatabaseUrl() || !hasPsql)("exported files, run with psql", () => {
  beforeAll(async () => {
    pair = await createPair();
    dir = mkdtempSync(path.join(os.tmpdir(), "dc-export-"));
  }, 120_000);
  afterAll(async () => {
    await disposePair(pair);
    rmSync(dir, { recursive: true, force: true });
  });

  const from = (s: string) => `
    CREATE SCHEMA ${s};
    CREATE TYPE ${s}.mood AS ENUM ('a');
    CREATE TABLE ${s}.t (id int PRIMARY KEY, old_col text, a int);
    CREATE TABLE ${s}.gone (id int);
    INSERT INTO ${s}.t VALUES (1, 'x', 10), (2, 'y', 20);`;
  const to = (s: string) => `
    CREATE SCHEMA ${s};
    CREATE TYPE ${s}.mood AS ENUM ('a', 'b');
    CREATE TABLE ${s}.t (id int PRIMARY KEY, a int, m ${s}.mood DEFAULT 'b');
    CREATE INDEX t_a ON ${s}.t (a);
    CREATE TABLE ${s}."we ird
name; --" (id int PRIMARY KEY);
    INSERT INTO ${s}.t (id, a) VALUES (1, 10), (2, 20);`;

  for (const format of ["sql", "updown", "dbmate", "goose", "flyway"] as const) {
    it(`${format}: the file runs, and makes the starting database look like the target`, async () => {
      const schema = `ex${++counter}`;
      const s = quote(schema);
      try {
        for (const [db, text] of [
          [pair.from, from(s)],
          [pair.to, to(s)],
        ] as const) {
          expect(await executeSql(db, [text])).toBeNull();
        }
        const start = await readStructure(pair.from);
        const target = await readStructure(pair.to);
        const plan = planMigration(start, target, { concurrentIndexes: true });
        expect(plan.steps.some((x) => !x.transactional)).toBe(true);
        const confirmed = new Set(
          plan.steps.filter((x) => x.risk.includes("destructive")).map((x) => x.id),
        );
        const result = buildExport(
          plan,
          { leftOut: new Set(), confirmed },
          {
            format,
            name: "export test",
            before: "from",
            after: "to",
            at: new Date(2026, 10, 19, 12, 0, 0),
          },
        );
        if (!result.ok) throw new Error(result.reason);
        const run = asRunnerWould(format, result.files);

        psql(pair.from, run.up, run.upTx);
        const migrated = await readStructure(pair.from);
        expect(
          describeDifferences(migrated, target, { before: "migrated", after: "target" }),
        ).toEqual([]);

        if (run.down !== null) psql(pair.from, run.down, run.downTx);
      } finally {
        for (const db of [pair.from, pair.to]) {
          await executeSql(db, [`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`]);
        }
      }
    });
  }

  it("holds a destructive step back until it is confirmed: the file runs and the table stays", async () => {
    const schema = `ex${++counter}`;
    const s = quote(schema);
    try {
      await executeSql(pair.from, [`CREATE SCHEMA ${s}; CREATE TABLE ${s}.gone (id int);`]);
      await executeSql(pair.to, [`CREATE SCHEMA ${s};`]);
      const plan = planMigration(await readStructure(pair.from), await readStructure(pair.to));
      const result = buildExport(
        plan,
        { leftOut: new Set(), confirmed: new Set() },
        { format: "sql", name: "held", before: "a", after: "b", at: new Date() },
      );
      if (!result.ok) throw new Error(result.reason);
      psql(pair.from, result.files[0]!.content, false);
      const after = await readStructure(pair.from);
      expect(after.tables.some((t) => t.name === "gone")).toBe(true);
    } finally {
      for (const db of [pair.from, pair.to]) {
        await executeSql(db, [`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`]);
      }
    }
  });
});
