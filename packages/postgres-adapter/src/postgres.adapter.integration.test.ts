/**
 * Integration tests: the real PostgreSQL adapter against a real PostgreSQL server.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set, so a plain `pnpm test` needs no
 * database. To run them, start a disposable server (see
 * examples/docker-compose.yml) and point the variable at its `postgres`
 * database, for example:
 *
 *   DATACANVAS_TEST_PG_URL="postgresql://postgres:testpass@127.0.0.1:54329/postgres?sslmode=disable"
 *
 * ISOLATION: every run creates its own uniquely named database (and role) inside
 * that server, loads examples/ecommerce.sql into it, and drops both afterwards.
 * Nothing else on the server is read or modified. NEVER point the variable at a
 * server whose data you care about: the account must be allowed to create
 * databases and roles.
 */
import { describeAdapterContract } from "@datacanvas/database-core/contract";
import type { ResolvedPostgresConnection } from "@datacanvas/shared-types";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withReadOnlyTransaction } from "./connection/read-only.js";
import { PostgresAdapter } from "./postgres.adapter.js";
import {
  createTestDatabase,
  quoteIdent,
  testDatabaseUrl,
  type TestDatabase,
} from "./testing/index.js";

describe.skipIf(!testDatabaseUrl())("PostgresAdapter against a real PostgreSQL", () => {
  let db: TestDatabase;
  let base: ResolvedPostgresConnection; // admin credentials, pointing at the test database
  let admin: pg.Client;
  let dbName: string;
  let suffix: string;
  let roleName: string;
  const rolePassword = "role-pw";
  const open: PostgresAdapter[] = [];

  /** A connection to the test database, optionally overriding some fields. */
  const connection = (
    overrides: Partial<ResolvedPostgresConnection> = {},
  ): ResolvedPostgresConnection => ({
    ...base,
    ...overrides,
  });
  const adapter = (
    overrides: Partial<ResolvedPostgresConnection> = {},
    options = {},
  ): PostgresAdapter => {
    const created = new PostgresAdapter(connection(overrides), options);
    open.push(created);
    return created;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ connection: base, admin, dbName, suffix } = db);
    roleName = `dc_noconnect_${suffix}`;
    // A role that may log in but may NOT connect to the test database.
    await admin.query(`CREATE ROLE ${quoteIdent(roleName)} LOGIN PASSWORD '${rolePassword}'`);
    await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
  });

  afterAll(async () => {
    await Promise.all(open.map((a) => a.disconnect()));
    if (db) {
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(roleName)}`).catch(() => {});
      await db.dispose();
    }
  });

  // The same behavioural suite the mock adapter passes.
  describeAdapterContract("PostgresAdapter", () => adapter());

  describe("PostgreSQL-specific metadata", () => {
    let a: PostgresAdapter;
    beforeAll(async () => {
      a = adapter();
      await a.connect();
    });

    it("hides system schemas", async () => {
      const names = (await a.getSchemas()).map((s) => s.name);
      expect(names).toEqual(["analytics", "public"]);
      await expect(a.getTables("pg_catalog")).rejects.toMatchObject({ code: "not_found" });
      await expect(a.getTables("information_schema")).rejects.toMatchObject({ code: "not_found" });
    });

    it("hides partitions but lists the partitioned parent", async () => {
      const names = (await a.getTables("public")).map((t) => t.name);
      expect(names).toContain("events");
      expect(names).not.toContain("events_2026");
    });

    it("reports table and column comments", async () => {
      const users = (await a.getTables("public")).find((t) => t.name === "users");
      expect(users?.comment).toBe("Registered customers");
      const email = (await a.getColumns("public", "users")).find((c) => c.name === "email");
      expect(email?.comment).toBe("Login e-mail address");
    });

    it("reports row-count estimates from statistics, and null for views", async () => {
      const tables = await a.getTables("public");
      expect(tables.find((t) => t.name === "users")?.estimatedRowCount).toBe(3);
      expect(tables.find((t) => t.name === "active_users")?.estimatedRowCount).toBeNull();
    });

    it("shows expression indexes as their expression, and non-btree methods", async () => {
      const users = await a.getIndexes("public", "users");
      expect(users.find((i) => i.name === "users_lower_full_name_idx")?.columns).toEqual([
        "lower(full_name)",
      ]);
      const products = await a.getIndexes("public", "products");
      expect(products.find((i) => i.name === "products_name_search_idx")).toMatchObject({
        method: "gin",
      });
    });

    it("lists only key columns of an index, not INCLUDE columns", async () => {
      const products = await a.getIndexes("public", "products");
      expect(products.find((i) => i.name === "products_sku_include_idx")).toMatchObject({
        columns: ["sku"],
        unique: true,
      });
    });

    it("puts the primary key index first", async () => {
      const orders = await a.getIndexes("public", "orders");
      expect(orders[0]).toMatchObject({ name: "orders_pkey", primary: true });
    });

    it("lists constraints primary key first, in a stable order", async () => {
      const kinds = (await a.getConstraints("public", "order_items")).map((c) => c.kind);
      expect(kinds).toEqual(["primary_key", "foreign_key", "foreign_key", "check"]);
    });

    it("detects one-to-one relationships from a primary key", async () => {
      const rel = (await a.getRelationships()).find((r) => r.name === "user_profiles_user_id_fkey");
      expect(rel).toMatchObject({ cardinality: "one-to-one" });
    });

    it("does not treat a PARTIAL unique index as one-to-one", async () => {
      const rel = (await a.getRelationships()).find((r) => r.name === "orders_user_id_fkey");
      expect(rel?.cardinality).toBe("many-to-one");
    });

    it("keeps composite foreign key columns aligned", async () => {
      const rel = (await a.getRelationships()).find((r) => r.source.table === "addresses");
      expect(rel).toMatchObject({
        source: { columns: ["country_code", "region_code"] },
        target: { table: "regions", columns: ["country_code", "region_code"] },
      });
    });

    it("reports a foreign key on a partitioned table once, not once per partition", async () => {
      const matches = (await a.getRelationships()).filter((r) => r.name === "events_user_id_fkey");
      expect(matches).toHaveLength(1);
      expect(matches[0]?.source.table).toBe("events");
    });

    it("returns a partition when it is asked for by name, even though listings hide it", async () => {
      const [entry] = await a.getTablesDetails([{ schema: "public", name: "events_2026" }]);
      expect(entry?.table.name).toBe("events_2026");
      expect(entry?.columns.map((c) => c.name)).toEqual(["id", "user_id", "at"]);
    });

    it("loads 150 tables in one call", async () => {
      const setup = new pg.Client({
        host: base.host,
        port: base.port,
        user: base.username,
        password: base.password,
        database: dbName,
        ssl: false,
      });
      await setup.connect();
      try {
        await setup.query(
          Array.from(
            { length: 150 },
            (_v, i) => `CREATE TABLE bulk_${i} (id serial PRIMARY KEY, name text, ref integer);`,
          ).join("\n"),
        );
      } finally {
        await setup.end();
      }

      const refs = Array.from({ length: 150 }, (_v, i) => ({
        schema: "public",
        name: `bulk_${i}`,
      }));
      const entries = await a.getTablesDetails(refs);

      expect(entries).toHaveLength(150);
      expect(entries.map((e) => e.table.name)).toEqual(refs.map((r) => r.name)); // request order
      for (const entry of entries) {
        expect(entry.columns.map((c) => c.name)).toEqual(["id", "name", "ref"]);
        expect(entry.constraints.map((c) => c.kind)).toEqual(["primary_key"]);
        expect(entry.indexes).toHaveLength(1);
      }
    });

    it("search skips partitions, and a hostile query is just text", async () => {
      const events = (await a.searchObjects("events", 20)).filter((h) => h.kind !== "column");
      expect(events.map((h) => h.table)).toEqual(["events"]); // events_2026 is a partition: hidden
      await expect(a.searchObjects("x'; DROP TABLE users; --", 10)).resolves.toEqual([]);
      expect((await a.getTables("public")).some((t) => t.name === "users")).toBe(true); // still there
    });

    it("search finds expression-free column names across schemas", async () => {
      const hits = await a.searchObjects("total_cents", 10);
      expect(hits).toEqual([
        {
          kind: "column",
          schema: "analytics",
          table: "daily_sales",
          column: "total_cents",
          dataType: "bigint",
        },
      ]);
    });

    it("never invents relationships from column names", async () => {
      // addresses.region_code and regions.region_code share a name but only the
      // declared composite key is reported; no other table pair is related.
      const pairs = (await a.getRelationships()).map((r) => `${r.source.table}->${r.target.table}`);
      expect(new Set(pairs)).toEqual(
        new Set([
          "orders->users",
          "order_items->orders",
          "order_items->products",
          "user_profiles->users",
          "addresses->regions",
          "events->users",
        ]),
      );
    });
  });

  describe("safety", () => {
    it("every query runs read-only: the server itself refuses writes", async () => {
      const pool = new pg.Pool({ ...connection(), user: base.username, ssl: false, max: 1 });
      try {
        await expect(
          withReadOnlyTransaction(pool, 5000, (db) =>
            db.query("INSERT INTO users (email) VALUES ('x@x.test')"),
          ),
        ).rejects.toMatchObject({ code: "25006" }); // read_only_sql_transaction
      } finally {
        await pool.end();
      }
    });

    it("cancels a statement that exceeds the timeout, and maps it to timeout", async () => {
      const pool = new pg.Pool({ ...connection(), user: base.username, ssl: false, max: 1 });
      try {
        const failure = await withReadOnlyTransaction(pool, 200, (db) =>
          db.query("SELECT pg_sleep(3)"),
        ).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: "57014" }); // query_canceled
      } finally {
        await pool.end();
      }
    });

    it("does not leak the statement timeout onto pooled connections", async () => {
      const pool = new pg.Pool({ ...connection(), user: base.username, ssl: false, max: 1 });
      try {
        await withReadOnlyTransaction(pool, 1234, (db) => db.query("SELECT 1"));
        // Same single connection is reused: the transaction-local setting must be gone.
        const { rows } = await pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
        expect(rows[0]?.statement_timeout).toBe("0");
      } finally {
        await pool.end();
      }
    });

    /**
     * Number of DataCanvas connections currently open to the test database.
     * Other adapters in this file stay connected until the end, so tests compare
     * against a baseline instead of expecting zero.
     */
    const countConnections = async (): Promise<number> => {
      const { rows } = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = 'datacanvas' AND datname = $1",
        [dbName],
      );
      return Number(rows[0]?.n);
    };

    /** The server notices a closed socket a few milliseconds later, so poll briefly. */
    const connectionsEventually = async (expected: number): Promise<number> => {
      let count = await countConnections();
      for (let attempt = 0; attempt < 20 && count !== expected; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        count = await countConnections();
      }
      return count;
    };

    it("identifies itself as datacanvas while connected, and releases its connections on disconnect", async () => {
      const baseline = await countConnections();

      const a = adapter();
      await a.connect();
      await a.getSchemas();
      expect(await countConnections()).toBeGreaterThan(baseline);

      await a.disconnect();
      expect(await connectionsEventually(baseline)).toBe(baseline);
    });

    it("testConnection() leaves no connection behind", async () => {
      const baseline = await countConnections();
      await adapter().testConnection();
      expect(await connectionsEventually(baseline)).toBe(baseline);
    });

    it("concurrent connect() calls are fine", async () => {
      const a = adapter();
      await Promise.all([a.connect(), a.connect(), a.connect()]);
      await expect(a.getSchemas()).resolves.toHaveLength(2);
    });
  });

  describe("connection failures are translated, and leak nothing", () => {
    const failureOf = async (
      a: PostgresAdapter,
      method: "connect" | "testConnection",
    ): Promise<unknown> =>
      a[method]().then(
        () => undefined,
        (error: unknown) => error,
      );

    for (const method of ["connect", "testConnection"] as const) {
      describe(method, () => {
        it("wrong password -> authentication_failed", async () => {
          const error = await failureOf(adapter({ password: "definitely-wrong" }), method);
          expect(error).toMatchObject({ code: "authentication_failed" });
        });

        it("unknown database -> database_not_found", async () => {
          const error = await failureOf(adapter({ database: `nope_${suffix}` }), method);
          expect(error).toMatchObject({ code: "database_not_found" });
        });

        it("nothing listening -> unreachable", async () => {
          const error = await failureOf(adapter({ port: 1 }), method);
          expect(error).toMatchObject({ code: "unreachable" });
        });

        it("verify-full against a server without TLS -> ssl_error", async () => {
          const error = await failureOf(adapter({ sslMode: "verify-full" }), method);
          expect(error).toMatchObject({ code: "ssl_error" });
        });

        it("require against a server without TLS -> ssl_error", async () => {
          const error = await failureOf(adapter({ sslMode: "require" }), method);
          expect(error).toMatchObject({ code: "ssl_error" });
        });

        it("a role that may not connect to the database -> permission_denied", async () => {
          const error = await failureOf(
            adapter({ username: roleName, password: rolePassword }),
            method,
          );
          expect(error).toMatchObject({ code: "permission_denied" });
        });
      });
    }

    it("never exposes credentials or host details in the error", async () => {
      const error = await failureOf(adapter({ password: "definitely-wrong-pw" }), "connect");
      const text = JSON.stringify(error) + String((error as Error).message);
      for (const secret of ["definitely-wrong-pw", base.username, base.host, dbName]) {
        expect(text).not.toContain(secret);
      }
    });

    it("a failed connect() leaves the adapter cleanly disconnected, and it can try again", async () => {
      const a = adapter({ password: "wrong" });
      await expect(a.connect()).rejects.toMatchObject({ code: "authentication_failed" });
      await expect(a.getSchemas()).rejects.toMatchObject({ code: "not_connected" });
      await expect(a.connect()).rejects.toMatchObject({ code: "authentication_failed" });
    });
  });
});
