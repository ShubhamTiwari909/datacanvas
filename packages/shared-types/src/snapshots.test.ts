/**
 * Snapshot contracts: the file format stays in step with the domain type, real
 * data passes, and hostile or damaged input is refused with messages that never
 * echo it.
 */
import {
  buildStructure,
  type DatabaseStructure,
  type TableDetailsEntry,
} from "@datacanvas/database-core";
import { createEcommerceData } from "@datacanvas/database-core/testing";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { structureSchema } from "./snapshots.js";
import {
  CURRENT_SNAPSHOT_VERSION,
  MAX_SNAPSHOT_OBJECTS_PER_KIND,
  MAX_SNAPSHOT_TABLES,
  SNAPSHOT_FORMAT,
  createSnapshotInputSchema,
  parseSnapshotFile,
  snapshotSchema,
  summarizeSnapshot,
  type Snapshot,
} from "./snapshots.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_proof?: T): void {}
// The stored structure must be exactly the domain's DatabaseStructure.
assertType<Same<z.infer<typeof structureSchema>, DatabaseStructure>>();

function sampleStructure(): DatabaseStructure {
  const data = createEcommerceData();
  const entries: TableDetailsEntry[] = data.tables.map((table) => {
    // The fixture keys its data as "schema.table".
    const key = `${table.schema}.${table.name}`;
    return {
      table,
      columns: data.columns[key] ?? [],
      constraints: data.constraints[key] ?? [],
      indexes: data.indexes[key] ?? [],
    };
  });
  return buildStructure(
    data.schemas.map((s) => s.name),
    entries,
    data.relationships,
    data.objects,
  );
}

function sampleSnapshot(): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    schemaVersion: CURRENT_SNAPSHOT_VERSION,
    id: "snap_abcdef12",
    name: "Before the migration",
    createdAt: "2026-11-14T10:00:00.000Z",
    source: { connectionName: "Shop", database: "shop" },
    structure: sampleStructure(),
  };
}

describe("snapshot file", () => {
  it("accepts a real structure (the sample shop) and keeps it unchanged", () => {
    const snapshot = sampleSnapshot();
    const { tables, relationships } = snapshot.structure;
    // Guard against a hollow fixture: the structure must actually contain things to validate.
    expect(tables.length).toBeGreaterThan(5);
    expect(tables.some((t) => t.columns.length > 0)).toBe(true);
    expect(tables.some((t) => t.indexes.length > 0)).toBe(true);
    expect(tables.some((t) => t.constraints.length > 0)).toBe(true);
    expect(relationships.length).toBeGreaterThan(0);
    const parsed = parseSnapshotFile(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed).toEqual({ ok: true, snapshot });
  });

  it("contains no row estimates", () => {
    expect(JSON.stringify(sampleSnapshot())).not.toContain("estimatedRowCount");
  });

  it("summarizes without the structure", () => {
    const summary = summarizeSnapshot(sampleSnapshot());
    expect(summary.counts.tables).toBe(sampleSnapshot().structure.tables.length);
    expect(summary).not.toHaveProperty("structure");
  });

  it("carries every kind of object (views, types, sequences, functions, triggers, extensions, policies)", () => {
    const objects = sampleSnapshot().structure.objects!;
    for (const kind of Object.keys(objects) as Array<keyof typeof objects>) {
      expect(objects[kind].length, kind).toBeGreaterThan(0);
    }
  });

  it("counts the objects in the summary, and says null when none were recorded", () => {
    const snapshot = sampleSnapshot();
    const total = Object.values(snapshot.structure.objects!).reduce((n, l) => n + l.length, 0);
    expect(summarizeSnapshot(snapshot).counts.objects).toBe(total);
    expect(
      summarizeSnapshot({ ...snapshot, structure: { ...snapshot.structure, objects: null } }).counts
        .objects,
    ).toBeNull();
  });
});

describe("upgrading a version 1 file", () => {
  /** What the previous release wrote: no `objects`, version 1. */
  function version1(): Record<string, unknown> {
    const file = JSON.parse(JSON.stringify(sampleSnapshot())) as Record<string, unknown> & {
      structure: Record<string, unknown>;
    };
    delete file.structure.objects;
    delete file.structure.ddl;
    return { ...file, schemaVersion: 1 };
  }

  it("is accepted and gets objects: null, which means not recorded, not none", () => {
    const parsed = parseSnapshotFile(version1());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.schemaVersion).toBe(CURRENT_SNAPSHOT_VERSION);
    expect(parsed.snapshot.structure.objects).toBeNull();
    expect(parsed.snapshot.structure.tables.length).toBeGreaterThan(5);
  });

  it("still refuses a damaged version 1 file", () => {
    const damaged = version1() as { structure: unknown };
    damaged.structure = "nonsense";
    expect(parseSnapshotFile(damaged).ok).toBe(false);
  });

  it("gets ddl: null too, on the way to the current version", () => {
    const parsed = parseSnapshotFile(version1());
    expect(parsed.ok && parsed.snapshot.structure.ddl).toBeNull();
  });

  it("does not accept a version 2 file that left objects out", () => {
    const file = JSON.parse(JSON.stringify(sampleSnapshot()));
    delete file.structure.objects;
    expect(parseSnapshotFile(file).ok).toBe(false);
  });
});

describe("refusing bad files", () => {
  const refused = (raw: unknown) => {
    const parsed = parseSnapshotFile(raw);
    if (parsed.ok) throw new Error("expected a refusal");
    return parsed.message;
  };

  it.each([
    ["not an object", 5],
    ["null", null],
    ["a list", []],
    ["another kind of file", { ...sampleSnapshot(), format: "datacanvas-workspace" }],
    ["no version", { ...sampleSnapshot(), schemaVersion: undefined }],
    ["version zero", { ...sampleSnapshot(), schemaVersion: 0 }],
  ])("refuses %s", (_name, raw) => {
    expect(parseSnapshotFile(raw).ok).toBe(false);
  });

  it("refuses a file from a newer release instead of guessing", () => {
    expect(refused({ ...sampleSnapshot(), schemaVersion: 4 })).toContain("newer version");
  });

  it("refuses unknown keys anywhere (strict objects)", () => {
    const withExtra = JSON.parse(JSON.stringify(sampleSnapshot()));
    withExtra.structure.tables[0].password = "oops";
    expect(parseSnapshotFile(withExtra).ok).toBe(false);
    expect(parseSnapshotFile({ ...sampleSnapshot(), extra: 1 }).ok).toBe(false);
  });

  it("has no place for row data: a rows key anywhere is refused", () => {
    const base = () => JSON.parse(JSON.stringify(sampleSnapshot()));
    const atTop = { ...base(), rows: [["secret"]] };
    expect(parseSnapshotFile(atTop).ok).toBe(false);
    const inStructure = base();
    inStructure.structure.rows = [{ id: "1" }];
    expect(parseSnapshotFile(inStructure).ok).toBe(false);
    const inTable = base();
    inTable.structure.tables[0].rows = [{ id: "1" }];
    expect(parseSnapshotFile(inTable).ok).toBe(false);
    const inColumn = base();
    inColumn.structure.tables.find(
      (t: { columns: unknown[] }) => t.columns.length > 0,
    ).columns[0].sample = "x";
    expect(parseSnapshotFile(inColumn).ok).toBe(false);
  });

  it("refuses an unsafe id (it becomes a file name)", () => {
    for (const id of ["../../etc/passwd", "a/b", "short", "x".repeat(65), "has space!", ""]) {
      expect(parseSnapshotFile({ ...sampleSnapshot(), id }).ok, id).toBe(false);
    }
  });

  it("refuses wrong types and out-of-range values", () => {
    const bad = JSON.parse(JSON.stringify(sampleSnapshot()));
    bad.structure.tables.find(
      (t: { columns: unknown[] }) => t.columns.length > 0,
    ).columns[0].nullable = "yes";
    expect(parseSnapshotFile(bad).ok).toBe(false);
    const kind = JSON.parse(JSON.stringify(sampleSnapshot()));
    kind.structure.tables[0].kind = "sequence";
    expect(parseSnapshotFile(kind).ok).toBe(false);
  });

  it("bounds everything, so a hostile file cannot make us allocate without limit", () => {
    const many = JSON.parse(JSON.stringify(sampleSnapshot()));
    many.structure.tables = Array.from(
      { length: MAX_SNAPSHOT_TABLES + 1 },
      () => many.structure.tables[0],
    );
    expect(parseSnapshotFile(many).ok).toBe(false);

    const longText = JSON.parse(JSON.stringify(sampleSnapshot()));
    longText.structure.tables[0].comment = "x".repeat(20_001);
    expect(parseSnapshotFile(longText).ok).toBe(false);

    const longName = JSON.parse(JSON.stringify(sampleSnapshot()));
    longName.structure.tables[0].name = "n".repeat(256);
    expect(parseSnapshotFile(longName).ok).toBe(false);
  });

  it("bounds objects too: a list, a definition and unknown keys", () => {
    const base = () => JSON.parse(JSON.stringify(sampleSnapshot()));

    const many = base();
    many.structure.objects.extensions = Array.from(
      { length: MAX_SNAPSHOT_OBJECTS_PER_KIND + 1 },
      () => many.structure.objects.extensions[0],
    );
    expect(parseSnapshotFile(many).ok).toBe(false);

    const longBody = base();
    longBody.structure.objects.functions[0].definition = "x".repeat(20_001);
    expect(parseSnapshotFile(longBody).ok).toBe(false);

    const extra = base();
    extra.structure.objects.views[0].owner = "alice";
    expect(parseSnapshotFile(extra).ok).toBe(false);

    const unknownKind = base();
    unknownKind.structure.objects.types[0].kind = "base";
    expect(parseSnapshotFile(unknownKind).ok).toBe(false);

    const wrongType = base();
    wrongType.structure.objects.sequences[0].cycle = "no";
    expect(parseSnapshotFile(wrongType).ok).toBe(false);
  });

  it("never echoes the file's content in a message", () => {
    const secret = "SECRET-TABLE-NAME";
    const bad = JSON.parse(JSON.stringify(sampleSnapshot()));
    bad.structure.tables[0].name = secret;
    bad.structure.tables[0].kind = "nonsense";
    expect(refused(bad)).not.toContain(secret);
    expect(refused({ ...sampleSnapshot(), id: secret.repeat(10) })).not.toContain(secret);
  });
});

describe("snapshotSchema and the create request", () => {
  it("accepts the stored shape", () => {
    expect(snapshotSchema.safeParse(sampleSnapshot()).success).toBe(true);
  });

  it("makes the name optional, trims it, and rejects blank names and unknown keys", () => {
    expect(createSnapshotInputSchema.parse({})).toEqual({});
    expect(createSnapshotInputSchema.parse({ name: "  Before  " })).toEqual({ name: "Before" });
    expect(createSnapshotInputSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createSnapshotInputSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
    expect(createSnapshotInputSchema.safeParse({ name: "a", extra: true }).success).toBe(false);
  });
});

describe("upgrading a version 2 file (1.6.0)", () => {
  function version2(): Record<string, unknown> {
    const file = JSON.parse(JSON.stringify(sampleSnapshot())) as Record<string, unknown> & {
      structure: Record<string, unknown>;
    };
    delete file.structure.ddl;
    return { ...file, schemaVersion: 2 };
  }

  it("is accepted and gets ddl: null, which means not recorded, not nothing special", () => {
    const parsed = parseSnapshotFile(version2());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.schemaVersion).toBe(CURRENT_SNAPSHOT_VERSION);
    expect(parsed.snapshot.structure.ddl).toBeNull();
    // What it did record is untouched.
    expect(parsed.snapshot.structure.objects).not.toBeNull();
  });

  it("does not accept a version 3 file that left ddl out", () => {
    const file = JSON.parse(JSON.stringify(sampleSnapshot()));
    delete file.structure.ddl;
    expect(parseSnapshotFile(file).ok).toBe(false);
  });

  it("keeps a recorded detail, and refuses one with an unknown key or an unknown identity", () => {
    const file = JSON.parse(JSON.stringify(sampleSnapshot()));
    file.structure.ddl = {
      serverVersion: 160004,
      columns: [
        {
          schema: "public",
          table: "t",
          column: "id",
          identity: "always",
          generated: null,
          collation: null,
        },
      ],
      constraints: [],
      tables: [],
      comments: [{ target: "schema", schema: "public", table: null, name: "public", comment: "x" }],
    };
    const parsed = parseSnapshotFile(file);
    expect(parsed.ok && parsed.snapshot.structure.ddl?.columns[0]?.identity).toBe("always");
    file.structure.ddl.columns[0].identity = "sometimes";
    expect(parseSnapshotFile(file).ok).toBe(false);
    file.structure.ddl.columns[0].identity = "always";
    file.structure.ddl.sql = "DROP TABLE x";
    expect(parseSnapshotFile(file).ok).toBe(false);
  });
});
