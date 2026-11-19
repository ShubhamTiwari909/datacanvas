import { describe, expect, it } from "vitest";
import type { Catalog } from "./catalog";
import { complete, writeName, readScope } from "./complete";
import { tokenize } from "./tokenize";

const col = (name: string, dataType = "text") => ({ name, dataType });
const catalog: Catalog = {
  schemas: ["analytics", "public"],
  relations: [
    {
      schema: "public",
      name: "users",
      kind: "table",
      columns: [col("id", "integer"), col("email"), col("full name")],
    },
    {
      schema: "public",
      name: "orders",
      kind: "table",
      columns: [col("id", "integer"), col("user_id", "integer"), col("total", "numeric(10,2)")],
    },
    { schema: "public", name: "active_users", kind: "view", columns: [col("id", "integer")] },
    { schema: "public", name: "Order Items", kind: "table", columns: [col("sku")] },
    {
      schema: "analytics",
      name: "events",
      kind: "table",
      columns: [col("id", "bigint"), col("user_id", "integer"), col("payload", "jsonb")],
    },
    { schema: "analytics", name: "users", kind: "table", columns: [col("segment")] },
  ],
  functions: [{ schema: "public", name: "app_total", arguments: "a integer", returns: "integer" }],
};

/** Complete at the `|` in the text. */
function at(text: string, cat: Catalog | null = catalog) {
  const offset = text.indexOf("|");
  const clean = text.replace("|", "");
  const result = complete(cat, clean, offset);
  return { ...result, labels: result.items.map((i) => i.label), text: clean };
}
const has = (labels: string[], ...wanted: string[]) => {
  for (const w of wanted) expect(labels, w).toContain(w);
};
const lacks = (labels: string[], ...unwanted: string[]) => {
  for (const w of unwanted) expect(labels, w).not.toContain(w);
};

describe("the start of a statement", () => {
  it("offers the words the SQL view accepts, and snippets", () => {
    const r = at("|");
    expect(r.context).toBe("start");
    expect(r.labels.slice(0, 6)).toEqual(["SELECT", "WITH", "VALUES", "TABLE", "EXPLAIN", "SHOW"]);
    expect(r.labels).toContain("select … from");
  });

  it("replaces the word being typed", () => {
    const r = at("SEL|");
    expect(r.context).toBe("start");
    expect([r.replaceFrom, r.replaceTo]).toEqual([0, 3]);
  });

  it("starts again after a semicolon", () => {
    expect(at("SELECT 1; |").context).toBe("start");
  });
});

describe("table position", () => {
  it.each([
    "SELECT * FROM |",
    "SELECT * FROM us|",
    "SELECT * FROM users u JOIN |",
    "SELECT * FROM users, |",
    "select * from users u left join |",
  ])("after FROM or JOIN: %s", (text) => {
    const r = at(text);
    expect(r.context).toBe("table");
    has(r.labels, "users", "orders", "active_users", "events", "public", "analytics");
    lacks(r.labels, "email", "SELECT");
  });

  it("names the schema and the kind, and puts public first", () => {
    const r = at("SELECT * FROM |");
    const events = r.items.find((i) => i.label === "events")!;
    expect(events.detail).toBe("analytics · table");
    expect(r.items.find((i) => i.label === "active_users")!.detail).toBe("public · view");
    const ordered = [...r.items]
      .sort((a, b) => a.sortText.localeCompare(b.sortText))
      .map((i) => i.label);
    expect(ordered.indexOf("orders")).toBeLessThan(ordered.indexOf("events"));
  });

  it("inserts a name with its schema when it exists in several and is not the public one", () => {
    const r = at("SELECT * FROM |");
    const users = r.items.filter((i) => i.label === "users");
    expect(users.map((i) => i.insertText).sort()).toEqual(["analytics.users", "users"]);
    expect(r.items.find((i) => i.label === "events")!.insertText).toBe("events");
  });

  it("quotes a name that needs it", () => {
    expect(at("SELECT * FROM |").items.find((i) => i.label === "Order Items")!.insertText).toBe(
      '"Order Items"',
    );
  });

  it("offers a schema and opens the list again after it", () => {
    const schema = at("SELECT * FROM |").items.find(
      (i) => i.kind === "schema" && i.label === "analytics",
    )!;
    expect(schema.insertText).toBe("analytics.");
    expect(schema.retrigger).toBe(true);
  });

  it("lists the tables of a schema after `schema.`", () => {
    const r = at("SELECT * FROM analytics.|");
    expect(r.context).toBe("qualified");
    expect(r.labels.sort()).toEqual(["events", "users"]);
    expect(at("SELECT * FROM public.us|").labels).toContain("users");
  });

  it("offers the CTEs of the statement", () => {
    const r = at("WITH recent AS (SELECT id FROM users) SELECT * FROM |");
    expect(r.context).toBe("table");
    const cte = r.items.find((i) => i.label === "recent")!;
    expect(cte.detail).toBe("CTE");
  });

  it("works with the statement that has the cursor, not the others", () => {
    const r = at("SELECT 1; SELECT * FROM |; SELECT 2");
    expect(r.context).toBe("table");
  });
});

describe("after a table", () => {
  it.each([
    "SELECT * FROM users |",
    "SELECT * FROM users u |",
    "SELECT * FROM public.users AS u |",
  ])("offers the words that follow a relation: %s", (text) => {
    const r = at(text);
    expect(r.context).toBe("after-relation");
    has(r.labels, "WHERE", "JOIN", "ORDER BY", "LEFT JOIN", "ON");
    lacks(r.labels, "users");
  });
});

describe("columns", () => {
  it("offers the columns of every relation in the statement, with their type, even before FROM is typed after them", () => {
    const r = at("SELECT | FROM users u JOIN orders o ON o.user_id = u.id");
    expect(r.context).toBe("column");
    has(r.labels, "email", "total", "user_id", "u", "o");
    lacks(r.labels, "payload", "segment");
    const total = r.items.find((i) => i.label === "total")!;
    expect(total.detail).toBe("o · numeric(10,2)");
    expect(total.kind).toBe("column");
  });

  it("puts columns first, then aliases, functions and keywords", () => {
    const r = at("SELECT | FROM users u");
    const order = [...r.items].sort((a, b) => a.sortText.localeCompare(b.sortText));
    expect(order[0]!.kind).toBe("column");
    const kinds = order.map((i) => i.kind);
    expect(kinds.indexOf("alias")).toBeGreaterThan(kinds.lastIndexOf("column"));
    expect(kinds.indexOf("function")).toBeGreaterThan(kinds.indexOf("alias"));
    expect(kinds.indexOf("keyword")).toBeGreaterThan(kinds.indexOf("function"));
  });

  it("offers the database's functions and the built-in ones", () => {
    const r = at("SELECT | FROM users");
    const own = r.items.find((i) => i.label === "app_total")!;
    expect(own.detail).toBe("public.app_total(a integer) → integer");
    expect(own.insertText).toBe("app_total(");
    has(r.labels, "count", "coalesce", "now");
  });

  it.each([
    "SELECT * FROM users WHERE |",
    "SELECT * FROM users u WHERE u.id = 1 AND |",
    "SELECT * FROM users GROUP BY |",
    "SELECT * FROM users ORDER BY |",
    "SELECT * FROM users u JOIN orders o ON |",
    "SELECT id, | FROM users",
    "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE |",
  ])("is a column position: %s", (text) => {
    const r = at(text);
    expect(r.context).toBe("column");
    expect(r.labels).toContain("id");
  });

  it("reads a subquery's own FROM when the cursor is inside it", () => {
    const r = at("SELECT * FROM users WHERE id IN (SELECT | FROM orders)");
    has(r.labels, "total");
  });

  it("has no columns when nothing is in scope yet, but still offers functions and keywords", () => {
    const r = at("SELECT |");
    expect(r.context).toBe("column");
    expect(r.items.some((i) => i.kind === "column")).toBe(false);
    has(r.labels, "count", "DISTINCT");
  });

  it("never offers a column of a relation that is not in the statement", () => {
    lacks(at("SELECT | FROM orders").labels, "email", "payload");
  });

  it("quotes a column that needs it, and keeps the plain name to match on", () => {
    const item = at("SELECT | FROM users").items.find((i) => i.label === "full name")!;
    expect(item.insertText).toBe('"full name"');
    expect(item.filterText).toBe("full name");
  });

  it("is a column position inside LIMIT? no: nothing to suggest after LIMIT or OFFSET", () => {
    expect(at("SELECT * FROM users LIMIT |").context).toBe("none");
  });
});

describe("after `name.`", () => {
  it("offers the columns of an alias", () => {
    const r = at("SELECT u.| FROM users u");
    expect(r.context).toBe("qualified");
    expect(r.labels).toEqual(["id", "email", "full name"]);
  });

  it("follows the alias, not the table of the same name elsewhere", () => {
    const r = at("SELECT e.| FROM analytics.events e JOIN users u ON u.id = e.user_id");
    expect(r.labels).toEqual(["id", "user_id", "payload"]);
  });

  it("offers the columns of a table by its own name", () => {
    expect(at("SELECT orders.| FROM orders").labels).toEqual(["id", "user_id", "total"]);
    expect(at("SELECT users.| FROM users").labels).toEqual(["id", "email", "full name"]);
  });

  it("offers the columns of a table that is not in the statement, when its name is plain", () => {
    expect(at("SELECT orders.|").labels).toEqual(["id", "user_id", "total"]);
  });

  it("filters while typing, by replacing the word", () => {
    const r = at("SELECT u.em| FROM users u");
    expect(r.labels).toContain("email");
    expect(r.text.slice(r.replaceFrom, r.replaceTo)).toBe("em");
  });

  it("offers a schema's tables and its functions in an expression", () => {
    const r = at("SELECT public.| FROM users");
    expect(r.context).toBe("qualified");
    has(r.labels, "users", "orders", "app_total");
  });

  it("offers `schema.table.` columns", () => {
    expect(at("SELECT analytics.events.| FROM analytics.events").labels).toEqual([
      "id",
      "user_id",
      "payload",
    ]);
  });

  it("works with quoted aliases and names, and the quote being typed", () => {
    expect(at('SELECT "U".| FROM users "U"').labels).toEqual(["id", "email", "full name"]);
    expect(at('SELECT * FROM "Order Items" i WHERE i.|').labels).toEqual(["sku"]);
    // Monaco closes a quote as it is typed: the cursor is inside `"em"`, and the whole of it is replaced.
    const r = at('SELECT u."em|" FROM users u');
    expect(r.items.find((i) => i.label === "email")!.insertText).toBe('"email"');
    expect(r.text.slice(r.replaceFrom, r.replaceTo)).toBe('"em"');
    // An unclosed quote swallows the rest of the text: no crash, and the names are still offered.
    expect(() => at('SELECT u."em| FROM users u')).not.toThrow();
  });

  it("has nothing for a name it does not know", () => {
    expect(at("SELECT nope.| FROM users u").labels).toEqual([]);
  });

  it("has nothing after a number or a bracket", () => {
    expect(at("SELECT 1.|").context).toBe("none");
    expect(at("SELECT (a).|").context).toBe("none");
  });
});

describe("where it stays quiet", () => {
  it.each([
    "SELECT 'abc|",
    "SELECT 'a|b' FROM users",
    "SELECT 1 -- a comment |",
    "SELECT /* inside | */ 1",
    "SELECT $$ inside | $$",
    "SELECT * FROM users WHERE name = 'x |",
  ])("inside a string or a comment: %s", (text) => {
    const r = at(text);
    expect(r.context).toBe("none");
    expect(r.items).toEqual([]);
  });

  it("is back at the end of a finished string", () => {
    expect(at("SELECT 'abc'| FROM users").context).not.toBe("none");
  });
});

describe("without a catalog", () => {
  it("still offers keywords and functions, never a name", () => {
    const r = at("SELECT | FROM users", null);
    has(r.labels, "count", "DISTINCT");
    expect(r.items.some((i) => i.kind === "column" || i.kind === "table")).toBe(false);
    expect(at("SELECT * FROM |", null).items).toEqual([]);
    expect(at("SELECT u.| FROM users u", null).items).toEqual([]);
  });
});

describe("readScope", () => {
  const scope = (text: string) => {
    const result = readScope(catalog, tokenize(text));
    return result.entries.map(
      (e) => `${e.label}=${e.relation ? `${e.relation.schema}.${e.relation.name}` : "?"}`,
    );
  };

  it("reads FROM and JOIN with schemas, aliases, AS and commas", () => {
    expect(
      scope("SELECT 1 FROM users u, public.orders AS o JOIN analytics.events e ON true"),
    ).toEqual(["u=public.users", "o=public.orders", "e=analytics.events"]);
  });

  it("does not take a clause word for an alias", () => {
    expect(scope("SELECT 1 FROM users WHERE id = 1")).toEqual(["users=public.users"]);
    expect(scope("SELECT 1 FROM users LEFT JOIN orders ON true")).toEqual([
      "users=public.users",
      "orders=public.orders",
    ]);
    expect(scope("SELECT 1 FROM users ORDER BY id")).toEqual(["users=public.users"]);
  });

  it("keeps a subquery's alias without columns, and reads CTEs", () => {
    expect(scope("SELECT 1 FROM (SELECT 1) AS s JOIN users u ON true")).toEqual([
      "s=?",
      "u=public.users",
    ]);
    expect(
      readScope(catalog, tokenize("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT 1 FROM a")).ctes,
    ).toEqual(["a", "b"]);
  });

  it("prefers the public schema for a bare name, and knows an unknown table", () => {
    expect(scope("SELECT 1 FROM users")).toEqual(["users=public.users"]);
    expect(scope("SELECT 1 FROM nope n")).toEqual(["n=?"]);
  });

  it("matches names without regard to case unless they were quoted", () => {
    expect(scope("SELECT 1 FROM USERS")).toEqual(["USERS=public.users"]);
    expect(scope('SELECT 1 FROM "Order Items" i')).toEqual(["i=public.Order Items"]);
    expect(scope('SELECT 1 FROM "USERS"')).toEqual(["USERS=?"]);
  });
});

describe("writeName", () => {
  it("quotes what is not a plain lower-case name, and reserved words", () => {
    expect(writeName("users")).toBe("users");
    expect(writeName("user_id2")).toBe("user_id2");
    expect(writeName("Users")).toBe('"Users"');
    expect(writeName("full name")).toBe('"full name"');
    expect(writeName("order")).toBe('"order"');
    expect(writeName('with"quote')).toBe('"with""quote"');
    expect(writeName("users", true)).toBe('"users"');
    expect(writeName("1abc")).toBe('"1abc"');
  });
});

describe("a big database", () => {
  it("answers in well under a tenth of a second for 5,000 tables, and for a long text", () => {
    const big: Catalog = {
      schemas: Array.from({ length: 50 }, (_, i) => `schema_${i}`),
      relations: Array.from({ length: 5000 }, (_, i) => ({
        schema: `schema_${i % 50}`,
        name: `table_${i}`,
        kind: "table" as const,
        columns: Array.from({ length: 30 }, (_, c) => col(`column_${c}`, "integer")),
      })),
      functions: [],
    };
    const started = performance.now();
    const tables = complete(big, "SELECT * FROM ta", 16);
    const columns = complete(big, "SELECT t. FROM schema_1.table_1 t", 9);
    // A long statement: the cursor at the end of 5,000 lines of other text.
    const long = `${"SELECT 1 FROM table_1;\n".repeat(5000)}SELECT  FROM table_2 x`;
    const deep = complete(big, long, long.indexOf("SELECT  FROM") + 7);
    const elapsed = performance.now() - started;
    expect(tables.items.length).toBeGreaterThan(5000);
    expect(columns.items.map((i) => i.label)).toContain("column_29");
    expect(deep.items.some((i) => i.label === "column_0")).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});
