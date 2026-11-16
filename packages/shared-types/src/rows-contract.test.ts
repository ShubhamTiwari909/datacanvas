/**
 * The request and response contracts for viewing table data (rows), and the
 * `dataAccess` setting of a connection: bounded, strict, and off by default.
 */
import { describe, expect, it } from "vitest";
import {
  connectionSummarySchema,
  dataAccessRequestSchema,
  rowsRequestSchema,
  rowsResponseSchema,
} from "./connections.js";
import {
  postgresConnectionInputSchema,
  resolvePostgresConnection,
  summarizePostgresConnection,
} from "./postgres-connection.js";

const base = { schema: "public", table: "users" };

describe("rowsRequestSchema", () => {
  it("fills in the defaults: 50 rows, the first page, nothing revealed", () => {
    expect(rowsRequestSchema.parse(base)).toEqual({
      ...base,
      pageSize: 50,
      cursor: null,
      revealColumns: [],
    });
  });

  it("accepts the limits", () => {
    expect(rowsRequestSchema.parse({ ...base, pageSize: 1 }).pageSize).toBe(1);
    expect(rowsRequestSchema.parse({ ...base, pageSize: 200 }).pageSize).toBe(200);
    expect(rowsRequestSchema.parse({ ...base, cursor: "x".repeat(4096) }).cursor).toHaveLength(
      4096,
    );
    expect(
      rowsRequestSchema.parse({ ...base, revealColumns: Array(100).fill("a") }).revealColumns,
    ).toHaveLength(100);
  });

  it.each([
    ["no schema", { table: "users" }],
    ["no table", { schema: "public" }],
    ["an empty table name", { ...base, table: "" }],
    ["a table name over 255 characters", { ...base, table: "t".repeat(256) }],
    ["a page size of 0", { ...base, pageSize: 0 }],
    ["a page size of 201", { ...base, pageSize: 201 }],
    ["a fractional page size", { ...base, pageSize: 1.5 }],
    ["a page size that is text", { ...base, pageSize: "50" }],
    ["an empty cursor", { ...base, cursor: "" }],
    ["a cursor over 4,096 characters", { ...base, cursor: "x".repeat(4097) }],
    ["a cursor that is not text", { ...base, cursor: 7 }],
    ["101 columns to reveal", { ...base, revealColumns: Array(101).fill("a") }],
    ["a reveal name that is not text", { ...base, revealColumns: [1] }],
  ])("refuses %s", (_name, body) => {
    expect(rowsRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each(["where", "orderBy", "order", "filter", "sql", "query", "limit", "offset", "columns"])(
    "has no place for a `%s`: the shape of the query never depends on the caller",
    (key) => {
      expect(rowsRequestSchema.safeParse({ ...base, [key]: "id > 0" }).success).toBe(false);
    },
  );
});

describe("rowsResponseSchema", () => {
  it("accepts a page and keeps NULL apart from the empty string", () => {
    const page = {
      columns: [{ name: "a", dataType: "text", masked: false, kind: "text" as const }],
      rows: [[{ value: null, truncated: false }], [{ value: "", truncated: false }]],
      nextCursor: null,
      order: { kind: "primary_key" as const, columns: ["a"] },
      hiddenColumns: 0,
      cutBySize: false,
      offsetCapped: false,
      rowSecurity: "off" as const,
      sort: null,
      filters: [],
      sortValueTooLong: false,
    };
    expect(rowsResponseSchema.parse({ page })).toEqual({ page });
    expect(rowsResponseSchema.safeParse({ page: { ...page, rowSecurity: "maybe" } }).success).toBe(
      false,
    );
  });
});

describe("dataAccessRequestSchema", () => {
  it("takes exactly a boolean", () => {
    expect(dataAccessRequestSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(dataAccessRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
    for (const body of [{}, { enabled: "yes" }, { enabled: 1 }, { enabled: true, extra: 1 }]) {
      expect(dataAccessRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

/**
 * A password for the tests that must prove it never leaks. Made up on every run
 * instead of written as a literal, so no password-looking text sits in the code.
 */
const PASSWORD = `pw-${Math.random().toString(36).slice(2, 12)}`;

describe("dataAccess on a connection", () => {
  const fields = {
    mode: "fields" as const,
    name: "Shop",
    host: "localhost",
    database: "shop",
    username: "alice",
    password: PASSWORD,
  };

  it("is optional in what a client sends, and is not part of the connection itself", () => {
    const input = postgresConnectionInputSchema.parse({ ...fields, dataAccess: true });
    const resolved = resolvePostgresConnection(input);
    expect(resolved).not.toHaveProperty("dataAccess");
    expect(postgresConnectionInputSchema.parse(fields)).not.toHaveProperty("dataAccess");
  });

  it("is accepted with a connection string too, and must be a boolean", () => {
    const string = {
      mode: "string" as const,
      name: "Shop",
      connectionString: "postgresql://alice@localhost/db",
    };
    expect(postgresConnectionInputSchema.safeParse({ ...string, dataAccess: true }).success).toBe(
      true,
    );
    expect(postgresConnectionInputSchema.safeParse({ ...string, dataAccess: "on" }).success).toBe(
      false,
    );
    expect(postgresConnectionInputSchema.safeParse({ ...fields, dataAccess: "on" }).success).toBe(
      false,
    );
  });

  it("is off in a summary unless asked for, and never carries the password", () => {
    const resolved = resolvePostgresConnection(postgresConnectionInputSchema.parse(fields));
    expect(summarizePostgresConnection(resolved).dataAccess).toBe(false);
    expect(summarizePostgresConnection(resolved, true).dataAccess).toBe(true);
    expect(JSON.stringify(summarizePostgresConnection(resolved, true))).not.toContain(PASSWORD);
  });

  it("is required in what the server sends (a summary without it is not a summary)", () => {
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
    expect(connectionSummarySchema.safeParse(summary).success).toBe(false);
    expect(connectionSummarySchema.safeParse({ ...summary, dataAccess: false }).success).toBe(true);
  });
});
