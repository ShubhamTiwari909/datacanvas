/**
 * Contracts for saved STRUCTURE SNAPSHOTS and the files they are stored in.
 *
 * A snapshot is a copy of a database's structure (schemas, tables, columns,
 * constraints, indexes, foreign keys) at one moment, so it can be compared
 * with the database later, or with another snapshot. It contains no table
 * rows, no row estimates and no credentials, and it is only ever written by
 * the server from what the adapter read.
 *
 * Snapshot files can also be IMPORTED, so they are untrusted input: every
 * string and list here has an upper bound, and unknown keys are rejected.
 *
 * File format (version 2), one JSON file per snapshot:
 *   { "format": "datacanvas-snapshot", "schemaVersion": 2, "id", "name",
 *     "createdAt", "source": { "connectionName", "database" } | null,
 *     "structure": { "schemas": [...], "tables": [...], "relationships": [...],
 *                    "objects": { views, types, sequences, functions, triggers,
 *                                 extensions, policies, rowSecurity } | null } }
 *
 * Version 2 added `objects`. A version 1 file is upgraded with `objects: null`,
 * which means "not recorded" (it is NOT the same as "there are none").
 */
import { z } from "zod";
import { snapshotIdSchema } from "./ids.js";
import { migrateToCurrent, type Migration } from "./versioned-file.js";

export const SNAPSHOT_FORMAT = "datacanvas-snapshot";
export const CURRENT_SNAPSHOT_VERSION = 2;

/** At most this many snapshots are kept, which bounds disk use. */
export const MAX_SNAPSHOTS = 100;
/** A database with more tables than this cannot be captured (and a file with more is refused). */
export const MAX_SNAPSHOT_TABLES = 5000;
const MAX_SCHEMAS = 1000;
const MAX_COLUMNS_PER_TABLE = 2000;
const MAX_ITEMS_PER_TABLE = 2000;
const MAX_RELATIONSHIPS = 25_000;
/** At most this many objects of one kind (functions, triggers, ...). A database with more cannot be captured. */
export const MAX_SNAPSHOT_OBJECTS_PER_KIND = 10_000;
const MAX_NAME = 255;
const MAX_TEXT = 20_000;

const name = z.string().max(MAX_NAME);
const text = z.string().max(MAX_TEXT);
const nameList = z.array(name).max(100);

const columnSchema = z.strictObject({
  name,
  ordinalPosition: z.number().int().min(1).max(100_000),
  dataType: z.string().max(1000),
  nullable: z.boolean(),
  defaultValue: text.nullable(),
  comment: text.nullable(),
});

const constraintSchema = z.strictObject({
  name,
  kind: z.enum(["primary_key", "foreign_key", "unique", "check"]),
  columns: nameList,
  definition: text.nullable(),
});

const indexSchema = z.strictObject({
  name,
  columns: z.array(z.string().max(1000)).max(100),
  unique: z.boolean(),
  primary: z.boolean(),
  method: z.string().max(100),
  definition: text.nullable(),
});

const referentialAction = z.enum(["no_action", "restrict", "cascade", "set_null", "set_default"]);
const relationshipEnd = z.strictObject({ schema: name, table: name, columns: nameList });

const relationshipSchema = z.strictObject({
  name,
  source: relationshipEnd,
  target: relationshipEnd,
  cardinality: z.enum(["many-to-one", "one-to-one"]),
  onDelete: referentialAction,
  onUpdate: referentialAction,
});

const objectRef = z.strictObject({ schema: name, name });
const viewSchema = z.strictObject({
  schema: name,
  name,
  materialized: z.boolean(),
  comment: text.nullable(),
  definition: text,
  dependsOn: z.array(objectRef).max(MAX_ITEMS_PER_TABLE),
});
const typeSchema = z.strictObject({
  schema: name,
  name,
  kind: z.enum(["enum", "composite", "domain", "range"]),
  comment: text.nullable(),
  values: z.array(name).max(10_000),
  attributes: z
    .array(z.strictObject({ name, dataType: z.string().max(1000) }))
    .max(MAX_COLUMNS_PER_TABLE),
  baseType: z.string().max(1000).nullable(),
  defaultValue: text.nullable(),
  constraints: z.array(text).max(MAX_ITEMS_PER_TABLE),
});
const bigNumber = z.string().max(40);
const sequenceSchema = z.strictObject({
  schema: name,
  name,
  dataType: z.string().max(100),
  start: bigNumber,
  increment: bigNumber,
  min: bigNumber,
  max: bigNumber,
  cache: bigNumber,
  cycle: z.boolean(),
  ownedBy: z.strictObject({ schema: name, table: name, column: name }).nullable(),
});
const functionSchema = z.strictObject({
  schema: name,
  name,
  kind: z.enum(["function", "procedure"]),
  arguments: text,
  returns: text.nullable(),
  language: z.string().max(100),
  volatility: z.enum(["immutable", "stable", "volatile"]),
  securityDefiner: z.boolean(),
  comment: text.nullable(),
  definition: text,
});
const triggerSchema = z.strictObject({
  schema: name,
  table: name,
  name,
  timing: z.enum(["before", "after", "instead_of"]),
  events: z.array(z.enum(["insert", "update", "delete", "truncate"])).max(4),
  level: z.enum(["row", "statement"]),
  function: z.string().max(600),
  state: z.enum(["enabled", "disabled", "replica", "always"]),
  definition: text,
});
const extensionSchema = z.strictObject({
  name,
  version: z.string().max(100),
  schema: name,
  comment: text.nullable(),
});
const policySchema = z.strictObject({
  schema: name,
  table: name,
  name,
  command: z.enum(["all", "select", "insert", "update", "delete"]),
  permissive: z.boolean(),
  roles: nameList,
  using: text.nullable(),
  withCheck: text.nullable(),
});
const rowSecuritySchema = z.strictObject({ schema: name, table: name, forced: z.boolean() });

const perKind = <T extends z.ZodType>(item: T) => z.array(item).max(MAX_SNAPSHOT_OBJECTS_PER_KIND);

export const objectsSchema = z.strictObject({
  views: perKind(viewSchema),
  types: perKind(typeSchema),
  sequences: perKind(sequenceSchema),
  functions: perKind(functionSchema),
  triggers: perKind(triggerSchema),
  extensions: perKind(extensionSchema),
  policies: perKind(policySchema),
  rowSecurity: perKind(rowSecuritySchema),
});

const tableSchema = z.strictObject({
  schema: name,
  name,
  kind: z.enum(["table", "view", "materialized_view", "foreign_table"]),
  comment: text.nullable(),
  columns: z.array(columnSchema).max(MAX_COLUMNS_PER_TABLE),
  constraints: z.array(constraintSchema).max(MAX_ITEMS_PER_TABLE),
  indexes: z.array(indexSchema).max(MAX_ITEMS_PER_TABLE),
});

export const structureSchema = z.strictObject({
  schemas: z.array(name).max(MAX_SCHEMAS),
  tables: z.array(tableSchema).max(MAX_SNAPSHOT_TABLES),
  relationships: z.array(relationshipSchema).max(MAX_RELATIONSHIPS),
  objects: objectsSchema.nullable(),
});

const snapshotNameSchema = z.string().trim().min(1, "Give the snapshot a name.").max(100);

/** Display-only hint about where the snapshot was taken. It is never used to connect to anything. */
export const snapshotSourceSchema = z.strictObject({
  connectionName: z.string().max(100),
  database: z.string().max(63),
});
export type SnapshotSource = z.infer<typeof snapshotSourceSchema>;

/** What a client sends to take a snapshot. A name is optional: the server makes one. */
export const createSnapshotInputSchema = z.strictObject({ name: snapshotNameSchema.optional() });
export type CreateSnapshotInput = z.infer<typeof createSnapshotInputSchema>;

/** The complete stored snapshot (version 1). */
export const snapshotSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  schemaVersion: z.literal(CURRENT_SNAPSHOT_VERSION),
  id: snapshotIdSchema,
  name: snapshotNameSchema,
  createdAt: z.iso.datetime(),
  source: snapshotSourceSchema.nullable(),
  structure: structureSchema,
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/** What the list shows: no structure. */
export const snapshotSummarySchema = z.object({
  id: snapshotIdSchema,
  name: z.string(),
  createdAt: z.string(),
  source: snapshotSourceSchema.nullable(),
  counts: z.object({
    schemas: z.number().int().nonnegative(),
    tables: z.number().int().nonnegative(),
    relationships: z.number().int().nonnegative(),
    /** Views, types, sequences, functions, triggers, extensions and policies together; null when not recorded. */
    objects: z.number().int().nonnegative().nullable(),
  }),
});
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

export const snapshotResponseSchema = z.object({ snapshot: snapshotSchema });
/** Answer to taking or importing a snapshot: the summary, not the whole structure. */
export const snapshotSummaryResponseSchema = z.object({ snapshot: snapshotSummarySchema });
export const listSnapshotsResponseSchema = z.object({ snapshots: z.array(snapshotSummarySchema) });
/** `GET /api/connections/:id/objects`: views, types, sequences, functions, triggers, extensions and policies. */
export const objectsResponseSchema = z.object({ objects: objectsSchema });
/** `GET /api/connections/:id/structure`: the live structure, not saved. */
export const structureResponseSchema = z.object({ structure: structureSchema });

export function summarizeSnapshot(snapshot: Snapshot): SnapshotSummary {
  const { schemas, tables, relationships, objects } = snapshot.structure;
  return {
    id: snapshot.id,
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    source: snapshot.source,
    counts: {
      schemas: schemas.length,
      tables: tables.length,
      relationships: relationships.length,
      objects: objects === null ? null : Object.values(objects).reduce((n, l) => n + l.length, 0),
    },
  };
}

/**
 * 1 -> 2: version 2 added `structure.objects`. A version 1 snapshot never
 * recorded them, so they become `null` ("not recorded"), never an empty list:
 * comparing it with a live database must not report every function as new.
 */
export const SNAPSHOT_MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: (data) => {
    const structure = data.structure;
    if (typeof structure !== "object" || structure === null || Array.isArray(structure))
      return data;
    return { ...data, structure: { ...structure, objects: null } };
  },
};

export type ParsedSnapshotFile =
  { ok: true; snapshot: Snapshot } | { ok: false; code: "invalid_snapshot_file"; message: string };

/**
 * Read a snapshot from untrusted JSON (a file on disk, or an import): upgrade
 * it to the current version, then validate it. The message never echoes the
 * file's content.
 */
export function parseSnapshotFile(raw: unknown): ParsedSnapshotFile {
  const migrated = migrateToCurrent(raw, {
    format: SNAPSHOT_FORMAT,
    current: CURRENT_SNAPSHOT_VERSION,
    migrations: SNAPSHOT_MIGRATIONS,
  });
  if (!migrated.ok) return { ok: false, code: "invalid_snapshot_file", message: migrated.message };

  const parsed = snapshotSchema.safeParse(migrated.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? ` (problem at "${issue.path.slice(0, 3).join(".")}")` : "";
    return {
      ok: false,
      code: "invalid_snapshot_file",
      message: `The snapshot file is damaged or incomplete${where}.`,
    };
  }
  return { ok: true, snapshot: parsed.data };
}
