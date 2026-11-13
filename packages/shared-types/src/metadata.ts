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

export const relationKindSchema = z.enum(["table", "view", "materialized_view"]);

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

// Inferred types are intentionally NOT exported: use the database-core types.
