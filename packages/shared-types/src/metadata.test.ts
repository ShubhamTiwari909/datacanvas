/**
 * Two kinds of checks:
 *  1. COMPILE-TIME: each Zod schema in metadata.ts must describe exactly the same
 *     type as its database-core interface. If either changes alone, `tsc` fails
 *     on this file, so the browser contract cannot silently drift from the domain.
 *  2. RUNTIME: real adapter output (the mock's sample data) passes the schemas.
 */
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseErrorCode,
  IndexInfo,
  RelationshipInfo,
  SchemaInfo,
  TableDetailsEntry,
  TableInfo,
} from "@datacanvas/database-core";
import { MockDatabaseAdapter, createEcommerceData } from "@datacanvas/database-core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { API_ERROR_CODES, type ApiErrorCode } from "./api-error.js";
import {
  connectionSummarySchema,
  MAX_TABLES_PER_DETAILS_REQUEST,
  relationshipsResponseSchema,
  tableDetailsResponseSchema,
  tablesDetailsRequestSchema,
  tablesDetailsResponseSchema,
  tablesResponseSchema,
} from "./connections.js";
import type {
  constraintInfoSchema,
  indexInfoSchema,
  relationshipInfoSchema,
  tableDetailsEntrySchema,
} from "./metadata.js";
import { columnInfoSchema, schemaInfoSchema, tableInfoSchema } from "./metadata.js";

/** True only when A and B are mutually assignable (the same shape). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compiles only when its type argument is `true`; does nothing at runtime. */
function assertType<T extends true>(_proof?: T): void {}

assertType<Same<z.infer<typeof schemaInfoSchema>, SchemaInfo>>();
assertType<Same<z.infer<typeof tableInfoSchema>, TableInfo>>();
assertType<Same<z.infer<typeof columnInfoSchema>, ColumnInfo>>();
assertType<Same<z.infer<typeof constraintInfoSchema>, ConstraintInfo>>();
assertType<Same<z.infer<typeof indexInfoSchema>, IndexInfo>>();
assertType<Same<z.infer<typeof relationshipInfoSchema>, RelationshipInfo>>();
assertType<Same<z.infer<typeof tableDetailsEntrySchema>, TableDetailsEntry>>();
// Every database error code must be a valid API error code.
assertType<[DatabaseErrorCode] extends [ApiErrorCode] ? true : false>();

describe("metadata schemas accept real adapter output", () => {
  const data = createEcommerceData();

  it("validates every model in the sample database", () => {
    expect(z.array(schemaInfoSchema).parse(data.schemas)).toEqual(data.schemas);
    expect(tablesResponseSchema.parse({ tables: data.tables }).tables).toEqual(data.tables);
    expect(
      relationshipsResponseSchema.parse({ relationships: data.relationships }).relationships,
    ).toEqual(data.relationships);
    for (const key of Object.keys(data.columns)) {
      const details = {
        columns: data.columns[key],
        constraints: data.constraints[key],
        indexes: data.indexes[key],
      };
      expect(tableDetailsResponseSchema.parse(details)).toEqual(details);
    }
  });

  it("validates bulk entries built from the sample data", async () => {
    const adapter = new MockDatabaseAdapter();
    await adapter.connect();
    const entries = await adapter.getTablesDetails([
      { schema: "public", name: "orders" },
      { schema: "analytics", name: "daily_sales" },
    ]);
    expect(tablesDetailsResponseSchema.parse({ tables: entries }).tables).toEqual(entries);
  });

  it("rejects malformed metadata", () => {
    expect(
      tableInfoSchema.safeParse({ schema: "public", name: "x", kind: "sequence" }).success,
    ).toBe(false);
    expect(columnInfoSchema.safeParse({ name: "id" }).success).toBe(false);
  });
});

describe("API error codes", () => {
  it("has no duplicates", () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });
});

describe("connectionSummarySchema", () => {
  const summary = {
    id: "abcdefghijklmnop",
    provider: "postgresql",
    name: "Shop",
    host: "localhost",
    port: 5432,
    database: "shop",
    username: "alice",
    sslMode: "disable",
    hasPassword: true,
    profileId: null,
  };

  it("accepts a summary and has no place for a password", () => {
    expect(connectionSummarySchema.parse(summary)).toEqual(summary);
    // Unknown keys are stripped, so even if a password were passed in, it would not come out.
    expect(connectionSummarySchema.parse({ ...summary, password: "secret" })).not.toHaveProperty(
      "password",
    );
  });

  it("rejects ids that are not URL-safe tokens", () => {
    expect(connectionSummarySchema.safeParse({ ...summary, id: "../etc/passwd" }).success).toBe(
      false,
    );
    expect(connectionSummarySchema.safeParse({ ...summary, id: "short" }).success).toBe(false);
  });
});

describe("tablesDetailsRequestSchema", () => {
  const ref = (name: string) => ({ schema: "public", name });

  it("accepts a list of tables", () => {
    expect(tablesDetailsRequestSchema.safeParse({ tables: [ref("a"), ref("b")] }).success).toBe(
      true,
    );
  });

  it("rejects an empty list, an oversized list, unknown keys and empty names", () => {
    expect(tablesDetailsRequestSchema.safeParse({ tables: [] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_TABLES_PER_DETAILS_REQUEST + 1 }, (_v, i) =>
      ref(`t${i}`),
    );
    expect(tablesDetailsRequestSchema.safeParse({ tables: tooMany }).success).toBe(false);
    expect(tablesDetailsRequestSchema.safeParse({ tables: [ref("a")], extra: 1 }).success).toBe(
      false,
    );
    expect(
      tablesDetailsRequestSchema.safeParse({ tables: [{ schema: "public", name: "" }] }).success,
    ).toBe(false);
    expect(
      tablesDetailsRequestSchema.safeParse({ tables: [{ ...ref("a"), extra: 1 }] }).success,
    ).toBe(false);
  });
});
