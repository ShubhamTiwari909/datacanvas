/**
 * Zod schemas for the database METADATA that travels from the server to the
 * browser (schemas, tables, columns, constraints, indexes, relationships).
 *
 * The domain types themselves live in @datacanvas/database-core. These schemas
 * exist so the browser can VERIFY what the server sent (the same principle as
 * for every other response). A type test (metadata.test.ts) fails to compile if
 * a schema here and its database-core interface ever drift apart.
 */
import { z } from "zod";

export const schemaInfoSchema = z.object({ name: z.string() });

export const relationKindSchema = z.enum(["table", "view", "materialized_view", "foreign_table"]);

export const tableInfoSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: relationKindSchema,
  comment: z.string().nullable(),
  estimatedRowCount: z.number().nullable(),
});

export const columnInfoSchema = z.object({
  name: z.string(),
  ordinalPosition: z.number(),
  dataType: z.string(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
  comment: z.string().nullable(),
});

export const constraintInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(["primary_key", "foreign_key", "unique", "check"]),
  columns: z.array(z.string()),
  definition: z.string().nullable(),
});

export const indexInfoSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  unique: z.boolean(),
  primary: z.boolean(),
  method: z.string(),
  definition: z.string().nullable(),
});

const referentialActionSchema = z.enum([
  "no_action",
  "restrict",
  "cascade",
  "set_null",
  "set_default",
]);

const relationshipEndSchema = z.object({
  schema: z.string(),
  table: z.string(),
  columns: z.array(z.string()),
});

export const relationshipInfoSchema = z.object({
  name: z.string(),
  source: relationshipEndSchema,
  target: relationshipEndSchema,
  cardinality: z.enum(["many-to-one", "one-to-one"]),
  onDelete: referentialActionSchema,
  onUpdate: referentialActionSchema,
});

/** One table with everything known about it (see TableDetailsEntry in database-core). */
export const tableDetailsEntrySchema = z.object({
  table: tableInfoSchema,
  columns: z.array(columnInfoSchema),
  constraints: z.array(constraintInfoSchema),
  indexes: z.array(indexInfoSchema),
});

export const searchHitSchema = z.object({
  kind: z.enum(["table", "view", "materialized_view", "foreign_table", "column"]),
  schema: z.string(),
  table: z.string(),
  column: z.string().nullable(),
  dataType: z.string().nullable(),
});

export const indexUsageReportSchema = z.object({
  statsReset: z.string().nullable(),
  inRecovery: z.boolean(),
  indexes: z.array(
    z.object({
      schema: z.string(),
      table: z.string(),
      index: z.string(),
      scans: z.number(),
      sizeBytes: z.number(),
      backsConstraint: z.boolean(),
      valid: z.boolean(),
    }),
  ),
});

export const rowPageSchema = z.object({
  columns: z.array(
    z.object({
      name: z.string(),
      dataType: z.string(),
      masked: z.boolean(),
      kind: z.enum(["text", "ordered", "other"]),
    }),
  ),
  rows: z.array(z.array(z.object({ value: z.string().nullable(), truncated: z.boolean() }))),
  nextCursor: z.string().nullable(),
  order: z.object({
    kind: z.enum(["primary_key", "unique_index", "none"]),
    columns: z.array(z.string()),
  }),
  hiddenColumns: z.number(),
  cutBySize: z.boolean(),
  offsetCapped: z.boolean(),
  rowSecurity: z.enum(["off", "applies", "exempt"]),
  sort: z.object({ column: z.string(), direction: z.enum(["asc", "desc"]) }).nullable(),
  sortValueTooLong: z.boolean(),
});

// Inferred types are intentionally NOT exported: use the database-core types.
