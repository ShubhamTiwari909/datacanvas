/**
 * Route-handler tests: every /api/connections endpoint, called the way Next.js
 * calls it (a Request in, a Response out), against mock adapters.
 *
 * A strong invariant is checked throughout: the password the test sends in
 * never appears in ANY response body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput } from "@/lib/server/test-support";
import { DELETE as deleteConnection } from "./[id]/route";
import { GET as getRelationships } from "./[id]/relationships/route";
import { GET as getSchemas } from "./[id]/schemas/route";
import { GET as searchRoute } from "./[id]/search/route";
import { GET as getTableDetails } from "./[id]/tables/[table]/route";
import { GET as getTables } from "./[id]/tables/route";
import { POST as postTableDetails } from "./[id]/table-details/route";
import { GET as listConnections, POST as createConnection } from "./route";
import { POST as testConnection } from "./test/route";

const SECRET = "s3cret-pw";
const BASE = "http://127.0.0.1:4747/api/connections";

/** Every response text seen, so the final test can check none contains the password. */
let seen: string[] = [];

// The parsed body is deliberately loosely typed: these tests probe many different
// response shapes, and the shapes themselves are checked by the Zod schemas elsewhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(
  response: Promise<Response> | Response,
): Promise<{ status: number; body: Json }> {
  const r = await response;
  const text = await r.text();
  seen.push(text);
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

const post = (url: string, body: unknown): Request =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

async function createOne(overrides: Record<string, unknown> = {}): Promise<string> {
  const { body } = await call(createConnection(post(BASE, fieldsInput(overrides))));
  return body.connection.id as string;
}

beforeEach(() => {
  seen = [];
  setServerContextForTests(createTestContext());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setServerContextForTests(undefined);
  vi.restoreAllMocks();
});

describe("POST /api/connections", () => {
  it("connects and answers 201 with a summary that has an id and no password", async () => {
    const { status, body } = await call(createConnection(post(BASE, fieldsInput())));
    expect(status).toBe(201);
    expect(body.connection).toMatchObject({
      provider: "postgresql",
      name: "Shop",
      host: "localhost",
      database: "shop",
      username: "alice",
      sslMode: "disable",
      hasPassword: true,
    });
    expect(body.connection.id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("accepts a pasted connection string", async () => {
    const { status, body } = await call(
      createConnection(
        post(BASE, {
          mode: "string",
          name: "From string",
          connectionString: `postgresql://alice:${SECRET}@db.example.com:5433/shop`,
        }),
      ),
    );
    expect(status).toBe(201);
    expect(body.connection).toMatchObject({
      host: "db.example.com",
      port: 5433,
      sslMode: "verify-full",
    });
  });

  it("answers 400 with the database's problem code when the details are wrong", async () => {
    const { status, body } = await call(
      createConnection(post(BASE, fieldsInput({ password: "wrong-password" }))),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("authentication_failed");
    expect((await call(listConnections())).body.connections).toEqual([]);
  });

  it("answers 502 when the server cannot be reached", async () => {
    const { status, body } = await call(
      createConnection(post(BASE, fieldsInput({ password: "no-such-host" }))),
    );
    expect(status).toBe(502);
    expect(body.error.code).toBe("unreachable");
  });

  it("answers 400 validation_error with field issues for malformed input", async () => {
    const { status, body } = await call(
      createConnection(post(BASE, { mode: "fields", name: "", host: "" })),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["name", "host", "database", "username"]),
    );
  });

  it("answers 415 for a body that is not JSON content", async () => {
    const request = new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect((await call(createConnection(request))).status).toBe(415);
  });

  it("answers 409 once the connection limit is reached", async () => {
    setServerContextForTests(createTestContext({ maxConnections: 1 }));
    await createOne();
    const { status, body } = await call(createConnection(post(BASE, fieldsInput())));
    expect(status).toBe(409);
    expect(body.error.code).toBe("connection_limit_reached");
  });
});

describe("POST /api/connections/test", () => {
  it("answers ok without remembering the connection", async () => {
    const { status, body } = await call(testConnection(post(`${BASE}/test`, fieldsInput())));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect((await call(listConnections())).body.connections).toEqual([]);
  });

  it("reports why the details do not work", async () => {
    const { status, body } = await call(
      testConnection(post(`${BASE}/test`, fieldsInput({ password: "wrong-password" }))),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("authentication_failed");
  });

  it("validates its input like the create endpoint", async () => {
    const { status, body } = await call(testConnection(post(`${BASE}/test`, { mode: "magic" })));
    expect(status).toBe(400);
    expect(body.error.code).toBe("validation_error");
  });
});

describe("GET /api/connections", () => {
  it("lists the connections that were created", async () => {
    const a = await createOne({ name: "One" });
    const b = await createOne({ name: "Two" });
    const { body } = await call(listConnections());
    expect(body.connections.map((c: { id: string }) => c.id)).toEqual([a, b]);
  });
});

describe("exploring a connection", () => {
  let id: string;
  beforeEach(async () => {
    id = await createOne();
  });

  it("GET schemas", async () => {
    const { status, body } = await call(
      getSchemas(new Request(`${BASE}/${id}/schemas`), params({ id })),
    );
    expect(status).toBe(200);
    expect(body.schemas.map((s: { name: string }) => s.name)).toEqual(["analytics", "public"]);
  });

  it("GET tables?schema=", async () => {
    const { status, body } = await call(
      getTables(new Request(`${BASE}/${id}/tables?schema=public`), params({ id })),
    );
    expect(status).toBe(200);
    expect(body.tables.map((t: { name: string }) => t.name)).toContain("orders");
  });

  it("GET tables without ?schema= is a validation error", async () => {
    const { status, body } = await call(
      getTables(new Request(`${BASE}/${id}/tables`), params({ id })),
    );
    expect(status).toBe(400);
    expect(body.error.issues[0].path).toBe("schema");
  });

  it("GET tables for an unknown schema is 404 not_found", async () => {
    const { status, body } = await call(
      getTables(new Request(`${BASE}/${id}/tables?schema=nope`), params({ id })),
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("GET table details returns columns, constraints and indexes", async () => {
    const { status, body } = await call(
      getTableDetails(
        new Request(`${BASE}/${id}/tables/orders?schema=public`),
        params({ id, table: "orders" }),
      ),
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["columns", "constraints", "indexes"]);
    expect(body.columns).toHaveLength(4);
  });

  it("GET table details for a missing table is 404", async () => {
    const { status } = await call(
      getTableDetails(
        new Request(`${BASE}/${id}/tables/nope?schema=public`),
        params({ id, table: "nope" }),
      ),
    );
    expect(status).toBe(404);
  });

  it("POST table-details loads many tables in one request", async () => {
    const { status, body } = await call(
      postTableDetails(
        post(`${BASE}/${id}/table-details`, {
          tables: [
            { schema: "public", name: "orders" },
            { schema: "analytics", name: "daily_sales" },
          ],
        }),
        params({ id }),
      ),
    );
    expect(status).toBe(200);
    expect(body.tables.map((t: { table: { name: string } }) => t.table.name)).toEqual([
      "orders",
      "daily_sales",
    ]);
    expect(body.tables[0].columns).toHaveLength(4);
  });

  it("POST table-details answers 404 for a missing table and 400 for a bad request", async () => {
    const missing = await call(
      postTableDetails(
        post(`${BASE}/${id}/table-details`, { tables: [{ schema: "public", name: "nope" }] }),
        params({ id }),
      ),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    for (const bad of [
      { tables: [] },
      { tables: "users" },
      {},
      { tables: [{ schema: "public" }] },
    ]) {
      const result = await call(
        postTableDetails(post(`${BASE}/${id}/table-details`, bad), params({ id })),
      );
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("validation_error");
    }
  });

  describe("GET search", () => {
    const search = (query: string) =>
      call(searchRoute(new Request(`${BASE}/${id}/search${query}`), params({ id })));

    it("finds tables and columns by name", async () => {
      const { status, body } = await search("?q=user");
      expect(status).toBe(200);
      const labels = body.hits.map(
        (h: { table: string; column: string | null }) =>
          `${h.table}${h.column ? `.${h.column}` : ""}`,
      );
      expect(labels).toEqual(expect.arrayContaining(["users", "orders.user_id"]));
    });

    it("applies the limit", async () => {
      const { body } = await search("?q=e&limit=2");
      expect(
        body.hits.filter((h: { kind: string }) => h.kind !== "column").length,
      ).toBeLessThanOrEqual(2);
    });

    it("rejects a missing, blank or oversized query and a bad limit", async () => {
      for (const bad of [
        "",
        "?q=",
        "?q=%20%20",
        `?q=${"x".repeat(101)}`,
        "?q=a&limit=0",
        "?q=a&limit=51",
        "?q=a&limit=abc",
      ]) {
        const result = await search(bad);
        expect(result.status, bad).toBe(400);
        expect(result.body.error.code).toBe("validation_error");
      }
    });

    it("answers 404 for an unknown connection", async () => {
      const result = await call(
        searchRoute(new Request(`${BASE}/x/search?q=a`), params({ id: "does-not-exist-123456" })),
      );
      expect(result.status).toBe(404);
    });
  });

  it("GET relationships", async () => {
    const { status, body } = await call(
      getRelationships(new Request(`${BASE}/${id}/relationships`), params({ id })),
    );
    expect(status).toBe(200);
    expect(body.relationships).toHaveLength(3);
  });

  it("answers 404 connection_not_found for an unknown id, on every endpoint", async () => {
    const unknown = params({ id: "does-not-exist-123456" });
    const responses = [
      getSchemas(new Request(`${BASE}/x/schemas`), unknown),
      getTables(new Request(`${BASE}/x/tables?schema=public`), unknown),
      getRelationships(new Request(`${BASE}/x/relationships`), unknown),
      postTableDetails(
        post(`${BASE}/x/table-details`, { tables: [{ schema: "public", name: "users" }] }),
        unknown,
      ),
      getTableDetails(
        new Request(`${BASE}/x/tables/t?schema=public`),
        params({ id: "does-not-exist-123456", table: "t" }),
      ),
      deleteConnection(new Request(`${BASE}/x`, { method: "DELETE" }), unknown),
    ];
    for (const response of responses) {
      const { status, body } = await call(response);
      expect(status).toBe(404);
      expect(body.error.code).toBe("connection_not_found");
    }
  });
});

describe("DELETE /api/connections/:id", () => {
  it("forgets the connection", async () => {
    const id = await createOne();
    const { status, body } = await call(
      deleteConnection(new Request(`${BASE}/${id}`, { method: "DELETE" }), params({ id })),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect((await call(listConnections())).body.connections).toEqual([]);
    expect(
      (await call(getSchemas(new Request(`${BASE}/${id}/schemas`), params({ id })))).status,
    ).toBe(404);
  });
});

describe("secrecy", () => {
  it("the password never appears in any response", async () => {
    // Exercise every endpoint, including failures, with a distinctive password.
    const id = await createOne({ password: SECRET });
    await call(createConnection(post(BASE, fieldsInput({ password: SECRET, name: "" }))));
    await call(testConnection(post(`${BASE}/test`, fieldsInput({ password: SECRET }))));
    await call(listConnections());
    await call(getSchemas(new Request(`${BASE}/${id}/schemas`), params({ id })));
    await call(getTables(new Request(`${BASE}/${id}/tables?schema=public`), params({ id })));
    await call(
      getTableDetails(
        new Request(`${BASE}/${id}/tables/users?schema=public`),
        params({ id, table: "users" }),
      ),
    );
    await call(getRelationships(new Request(`${BASE}/${id}/relationships`), params({ id })));
    await call(
      createConnection(
        post(BASE, { mode: "string", name: "x", connectionString: `mysql://alice:${SECRET}@h/db` }),
      ),
    );

    expect(seen.length).toBeGreaterThan(8);
    for (const text of seen) expect(text).not.toContain(SECRET);
  });
});
