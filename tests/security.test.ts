/**
 * Security rules, enforced as tests so they cannot be broken quietly.
 *
 *  1. Every API route handler is guarded (Host / Origin / session token).
 *  2. There is never an arbitrary-SQL endpoint.
 *  3. No code sends CORS headers (other sites must not read our responses).
 *  4. The CLI never binds beyond loopback.
 *  5. Table rows are read only behind the data-access check, and are never logged.
 *  6. In the browser, rows live in component state only: never stored, never saved.
 *  7. A sort and the conditions of a read are structured data, strict all the way
 *     down, and never become SQL text; they are never saved or kept in a store.
 *  8. The product-wide documents never claim that rows are not read (they can be,
 *     when a person switches data viewing on), and they do mention data viewing.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === ".next") return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const apiDir = path.join(root, "apps/web/app/api");
const routeFiles = walk(apiDir).filter((f) => f.endsWith(`${path.sep}route.ts`));
const rel = (file: string) => path.relative(root, file);

describe("API routes are guarded", () => {
  it("finds the route files", () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it.each(routeFiles.map((f) => [rel(f), f]))("%s runs the guard", (_name, file) => {
    const code = readFileSync(file as string, "utf8");
    if (code.includes("notFound")) return; // the JSON 404 catch-all touches no data
    // handleRoute(request, ...) re-checks Host, Origin and token; health calls guardRequest.
    expect(code).toMatch(/handleRoute\(\s*request\b|guardRequest\(\s*request\b/);
  });

  it("has proxy.ts in front of every route", () => {
    const proxy = readFileSync(path.join(root, "apps/web/proxy.ts"), "utf8");
    expect(proxy).toContain("evaluateRequest");
  });
});

describe("no arbitrary SQL, ever (but the one route of the SQL view)", () => {
  it("has no route whose path suggests running SQL (the SQL view's route is called run)", () => {
    for (const file of routeFiles) {
      expect(rel(file).toLowerCase(), rel(file)).not.toMatch(/\b(sql|query|exec|execute|raw)\b/);
    }
  });
});

describe("the SQL view: exactly one route takes SQL text (decision 141)", () => {
  const runRoute = "apps/web/app/api/connections/[id]/run/route.ts";
  const service = path.join(root, "apps/web/lib/server/sql-service.ts");

  it("has exactly one route that reaches the SQL service, and it is the run route", () => {
    const users = routeFiles
      .filter((f) => /\.sql\.run\(/.test(readFileSync(f, "utf8")))
      .map((f) => rel(f));
    expect(users).toEqual([runRoute]);
  });

  it("takes only a JSON POST with the strict schema, never cached, with no GET", () => {
    const code = readFileSync(path.join(root, runRoute), "utf8");
    expect(code).toMatch(/export function POST\b/);
    // No other way of exporting a handler for another method, whatever the form.
    expect(code).not.toMatch(
      /export\s+(async\s+)?(function|const|let|var)\s+(GET|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/,
    );
    expect(code).not.toMatch(/export\s*\{[^}]*\b(GET|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[^}]*\}/);
    // The body is parsed with the strict schema, before anything else, and the answer is the no-store helper's.
    expect(code).toMatch(/parseJsonBody\(\s*request\s*,\s*sqlRunRequestSchema\b/);
    expect(code).toMatch(/return\s+jsonResponse\(/);
    expect(code).toMatch(/handleRoute\(\s*request\b/);
    expect(code.indexOf("parseJsonBody(")).toBeLessThan(code.indexOf(".sql.run("));
  });

  it("the request schema is strict and has no key besides the text and two limits", () => {
    const source = readFileSync(path.join(root, "packages/shared-types/src/sql.ts"), "utf8");
    const start = source.indexOf("export const sqlRunRequestSchema");
    const body = source.slice(start, source.indexOf("});", start));
    expect(body).toContain("z.strictObject");
    expect([...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])).toEqual([
      "text",
      "maxRows",
      "timeoutMs",
    ]);
  });

  it("checks the connection, the viewing switch and the text before it uses the adapter", () => {
    const code = readFileSync(service, "utf8");
    const body = code.slice(code.indexOf("async run("));
    const order = [
      "connection_not_found",
      "summary.dataAccess",
      "checkStatementText",
      "sql_busy",
      "this.connections.use(",
    ].map((needle) => body.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("has no code in the SQL path that writes to the console", () => {
    for (const file of [
      "apps/web/lib/server/sql-service.ts",
      runRoute,
      "packages/postgres-adapter/src/connection/run-statement.ts",
      "packages/database-core/src/sql-run.ts",
    ]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(/\bconsole\./);
    }
  });

  it("opens a connection of its own and never takes one from the pool", () => {
    const code = readFileSync(
      path.join(root, "packages/postgres-adapter/src/connection/run-statement.ts"),
      "utf8",
    );
    expect(code).toContain("new pg.Client(");
    expect(code).not.toMatch(/pool\.connect|new pg\.Pool|pool\.query/);
    // Read-only, and one statement (a named statement makes the driver use the extended protocol).
    expect(code).toContain("BEGIN READ ONLY");
    expect(code).toContain("name: STATEMENT_NAME");
  });
});

describe("the SQL view: the documents say what it is", () => {
  const flat = (file: string) =>
    readFileSync(path.join(root, file), "utf8").replace(/\s+/g, " ").toLowerCase();
  const documents = ["README.md", "SECURITY.md", "docs/getting-started.md", "docs/threat-model.md"];

  it.each(documents)("%s describes the SQL view as read-only", (file) => {
    const content = flat(file);
    expect(content, file).toContain("sql");
    expect(content, file).toMatch(/sql[*`]* (tab|view)/);
    expect(content, file).toMatch(/read-only/);
  });

  it("SECURITY.md names what keeps it narrow, and what it cannot stop", () => {
    const security = flat("SECURITY.md");
    expect(security).toContain("one statement");
    expect(security).toContain("connection opened for that run");
    expect(security).toMatch(/first word must be/);
    expect(security).toMatch(/explain analyze create table/);
    expect(security).toMatch(/masking does not apply/);
    expect(security).toMatch(/the role is the control/);
    expect(security).toMatch(/nothing is kept/);
  });

  it("no product document says there is no way to run SQL, without the SQL tab beside it", () => {
    const claim = /no (way|box|endpoint)[^.]{0,40}(run|type)[^.]{0,20}sql/g;
    for (const file of [...documents, "docs/architecture.md"]) {
      const content = flat(file);
      for (const match of content.matchAll(claim)) {
        const around = content.slice(Math.max(0, match.index - 200), match.index + 260);
        expect(around, `${file}: "${match[0]}"`).toMatch(
          /sql (tab|view)|except|attacker 8|1\.6\.0/,
        );
      }
    }
  });

  it("the threat model has the review of the runner, with its two high findings", () => {
    const model = flat("docs/threat-model.md");
    expect(model).toContain("review of the sql runner");
    expect(model).toMatch(/carriage return/);
    expect(model).toMatch(/explain analyze create table/);
  });
});

describe("no CORS", () => {
  it("never sets Access-Control-* headers in app code", () => {
    const files = walk(path.join(root, "apps/web")).filter(
      (f) => /\.(ts|tsx|mjs)$/.test(f) && !f.endsWith(".test.ts") && !f.includes("node_modules"),
    );
    for (const file of files) {
      expect(readFileSync(file, "utf8").toLowerCase(), rel(file)).not.toContain(
        "access-control-allow",
      );
    }
  });
});

describe("loopback only", () => {
  it("the CLI never mentions an all-interfaces address", () => {
    const files = walk(path.join(root, "packages/cli/src")).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const code = readFileSync(file, "utf8");
      // Comments may warn about it; code must not use it.
      const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(withoutComments, rel(file)).not.toContain("0.0.0.0");
    }
  });
});

describe("table rows are read only behind the data-access check", () => {
  const appCode = walk(path.join(root, "apps/web")).filter(
    (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("node_modules"),
  );
  const service = path.join(root, "apps/web/lib/server/connection-service.ts");
  const rowsRoute = path.join(root, "apps/web/app/api/connections/[id]/rows/route.ts");

  it("calls getRows only in the connection service, and in the one route that asks the service", () => {
    const callers = appCode.filter((f) => /\.getRows\(/.test(readFileSync(f, "utf8")));
    // (The MCP service asks the connection SERVICE for a page, as the route does: it never holds an adapter; checked below.)
    expect(callers.map(rel).sort()).toEqual(
      [rel(rowsRoute), rel(service), "apps/web/lib/server/mcp-service.ts"].sort(),
    );
    expect(readFileSync(path.join(root, "apps/web/lib/server/mcp-service.ts"), "utf8")).toMatch(
      /this\.rows\.getRows\(/,
    );
    // The route asks the SERVICE (which checks the setting); it never holds an adapter.
    const route = readFileSync(rowsRoute, "utf8");
    expect(route).toMatch(/connections\.getRows\(/);
    expect(route).not.toMatch(/adapter/i);
  });

  it("refuses when data access is off before it uses the adapter", () => {
    const code = readFileSync(service, "utf8");
    const start = code.indexOf("getRows(id: string");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);
    const refusal = body.indexOf("data_access_disabled");
    const use = body.indexOf("this.connections.use(");
    expect(refusal).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(use);
    // ... and the check is on the connection's own setting.
    expect(body.slice(0, refusal)).toMatch(/summary\.dataAccess/);
  });

  it("serves rows only through a JSON POST, never cached", () => {
    const code = readFileSync(rowsRoute, "utf8");
    expect(code).toMatch(/export function POST\b/);
    expect(code).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE|HEAD)\b/);
    expect(code).toContain("jsonResponse"); // no-store
    expect(code).toContain("rowsRequestSchema"); // the strict schema: no where, orderBy or sql
  });

  it("switches data access only with a PUT of a strict body", () => {
    const code = readFileSync(
      path.join(root, "apps/web/app/api/connections/[id]/data-access/route.ts"),
      "utf8",
    );
    expect(code).toMatch(/export function PUT\b/);
    expect(code).not.toMatch(/export (async )?function (GET|POST|PATCH|DELETE)\b/);
    expect(code).toContain("dataAccessRequestSchema");
  });

  it("has no code in the row path that writes to the console", () => {
    const files = [
      "apps/web/lib/server/connection-service.ts",
      "apps/web/lib/server/rows-gate.ts",
      "apps/web/app/api/connections/[id]/rows/route.ts",
      "apps/web/app/api/connections/[id]/data-access/route.ts",
      "packages/postgres-adapter/src/introspection/rows.ts",
      "packages/postgres-adapter/src/postgres.adapter.ts",
      "packages/database-core/src/rows.ts",
    ];
    for (const file of files) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(/\bconsole\./);
    }
  });

  it("keeps a sort and conditions out of everything that is saved", () => {
    for (const file of [
      "packages/shared-types/src/workspace.ts",
      "packages/shared-types/src/snapshots.ts",
      "packages/shared-types/src/profiles.ts",
    ]) {
      const code = readFileSync(path.join(root, file), "utf8");
      expect(code, file).not.toMatch(/RowFilter|RowSort|rowFilterSchema|rowSortSchema|ROW_FILTER/);
    }
  });
});

describe("one cell is read whole only behind the same data-access check", () => {
  const appCode = walk(path.join(root, "apps/web")).filter(
    (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("node_modules"),
  );
  const service = path.join(root, "apps/web/lib/server/connection-service.ts");
  const cellRoute = path.join(root, "apps/web/app/api/connections/[id]/rows/cell/route.ts");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("calls getCell on an adapter only in the connection service, and the route asks the service", () => {
    const callers = appCode.filter((f) => /\badapter\.getCell\(/.test(readFileSync(f, "utf8")));
    expect(callers.map(rel)).toEqual([rel(service)]);
    const route = readFileSync(cellRoute, "utf8");
    expect(route).toMatch(/connections\.getCell\(/);
    expect(route).not.toMatch(/adapter/i);
  });

  it("refuses when data access is off before it uses the adapter", () => {
    const code = readFileSync(service, "utf8");
    const start = code.indexOf("getCell(id: string");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("unlinkProfile(", start));
    const refusal = body.indexOf("data_access_disabled");
    const use = body.indexOf("this.connections.use(");
    expect(refusal).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(refusal);
    expect(body.slice(0, refusal)).toMatch(/summary\.dataAccess/);
    // It waits its turn with the other reads of the connection.
    expect(body).toContain("this.rowsGate.run(");
  });

  it("is a JSON POST with a strict body, never cached", () => {
    const code = readFileSync(cellRoute, "utf8");
    expect(code).toMatch(/export function POST\b/);
    expect(code).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE|HEAD)\b/);
    expect(code).toContain("jsonResponse");
    expect(code).toContain("cellRequestSchema");
    expect(read("packages/shared-types/src/connections.ts")).toMatch(
      /cellRequestSchema = z\s*\.strictObject/,
    );
  });

  it("names the row by the table's whole key from the catalog, binds every value, reads only JSON, and never reads a hidden column", () => {
    const code = stripComments(read("packages/postgres-adapter/src/introspection/rows.ts"));
    const start = code.indexOf("export async function readCell");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);
    // Only a json or jsonb column.
    expect(body).toMatch(/kinds\.get\(column\.name\) !== "json"/);
    // A column that looks sensitive is read only when it was revealed (as a page does).
    expect(body).toMatch(
      /isSensitiveColumnName\(column\.name\) && !request\.revealColumns\.includes/,
    );
    // The key must be the whole key, each column once, and a name of the catalog.
    expect(body).toMatch(/request\.key\.length !== order\.columns\.length/);
    expect(body).toMatch(
      /given\.has\(part\.column\) \|\| !order\.columns\.includes\(part\.column\)/,
    );
    // The statement is built from catalog names, quoted; the values are bound parameters.
    expect(body).toMatch(/quoteIdentifier\(column\.name\)/);
    expect(body).toMatch(/values\.push\(given\.get\(name\)\)/);
    expect(body).not.toMatch(/\$\{(request|part|given)\b/);
  });

  it("has no code in the cell path that writes to the console", () => {
    for (const file of [
      "apps/web/app/api/connections/[id]/rows/cell/route.ts",
      "apps/web/features/json/json-editor-dialog.tsx",
      "apps/web/features/json/json-code-editor.tsx",
    ]) {
      expect(read(file), file).not.toMatch(/\bconsole\./);
    }
  });

  it("never reaches the stores, the autosave or the saved layouts", () => {
    const places = [
      ...walk(path.join(root, "apps/web/stores")),
      ...walk(path.join(root, "apps/web/features/workspaces")),
      ...walk(path.join(root, "apps/web/features/canvas")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(places.length).toBeGreaterThan(5);
    for (const file of places) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /\bgetCell\b|cellResponseSchema|cellRequestSchema|features\/json\//,
      );
    }
  });
});

describe("a validation never changes a row", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const appCode = walk(path.join(root, "apps/web")).filter(
    (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("node_modules"),
  );
  const service = path.join(root, "apps/web/lib/server/connection-service.ts");
  const route = path.join(root, "apps/web/app/api/connections/[id]/rows/validate/route.ts");

  it("runs in a transaction that is read-only before any value goes in, and is never committed", () => {
    const code = stripComments(
      read("packages/postgres-adapter/src/connection/checking-transaction.ts"),
    );
    const readOnly = code.indexOf('"SET TRANSACTION READ ONLY"');
    const prepare = code.indexOf("await prepare(db)");
    const work = code.indexOf("await work(db)");
    expect(prepare).toBeGreaterThan(-1);
    expect(readOnly).toBeGreaterThan(prepare);
    expect(work).toBeGreaterThan(readOnly);
    // Rolled back in `finally`, whatever happened; there is no COMMIT anywhere.
    expect(code).toMatch(/finally \{[\s\S]*"ROLLBACK"/);
    expect(code).not.toMatch(/COMMIT/);
    // The timeouts are local to the transaction.
    expect(code).toMatch(/set_config\('statement_timeout', \$1, true\)/);
  });

  it("writes only into its own temporary copy: no other table is named in a statement that changes data", () => {
    const code = stripComments(read("packages/postgres-adapter/src/validation/validate-rows.ts"));
    // The text of every statement is a template literal, where the words of SQL are.
    const texts = code.match(/`[^`]*`/g) ?? [];
    // Its words, without the `${...}` parts (the name of the copy is a constant called COPY there).
    const words = (t: string) => t.replace(/\$\{[^}]*\}/g, "");
    const changing = texts.filter((t) =>
      /\b(INSERT INTO|CREATE TEMP TABLE|ALTER TABLE|UPDATE|DELETE FROM|TRUNCATE|DROP|COPY)\b/.test(
        words(t),
      ),
    );
    expect(changing.length).toBeGreaterThan(3);
    // Every statement that changes anything is CREATE TEMP TABLE, ALTER of the copy, or INSERT into the copy.
    for (const statement of changing) {
      expect(statement, statement).toMatch(
        /^`(INSERT INTO|ALTER TABLE|CREATE TEMP TABLE) \$\{quoteIdentifier\(COPY\)\}/,
      );
    }
    for (const text of texts) {
      expect(words(text), text).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE|DROP|COPY|CASCADE)\b/);
    }
    // The copy has no defaults (a copied default can advance a real sequence), no indexes, no identity, no triggers.
    expect(code).not.toMatch(
      /INCLUDING (DEFAULTS|INDEXES|IDENTITY|ALL|STORAGE|COMMENTS|STATISTICS)/,
    );
    expect(code).toContain("INCLUDING CONSTRAINTS INCLUDING GENERATED");
    expect(code).not.toMatch(/nextval|setval|CREATE (TRIGGER|INDEX|SEQUENCE)/i);
  });

  it("holds no value in a statement's text: values are bound, names come from the catalog", () => {
    const code = stripComments(read("packages/postgres-adapter/src/validation/validate-rows.ts"));
    // A value of the request never appears inside a template literal.
    expect(code).not.toMatch(/\$\{[^}]*\b(row|rows|value|values|slice|arrays)\b[^}]*\}/);
    // The values travel in these arrays and nowhere else.
    expect(code).toMatch(/await db\.query\(insert, arrays\)/);
    expect(code).not.toMatch(/\$\{request\.(rows|key)/);
    // The one request name that reaches a statement is checked against the catalog first (a column, the key).
    expect(code).toMatch(/byName\.get\(name\)/);
    expect(code).toMatch(/order\.columns\.includes\(part\.column\)/);
    // It never reads a message of the database (it can hold a value).
    expect(code).not.toMatch(/\.message\b/);
  });

  it("never reaches the write capability or the write connection", () => {
    for (const file of [
      "packages/postgres-adapter/src/validation/validate-rows.ts",
      "packages/postgres-adapter/src/connection/checking-transaction.ts",
    ]) {
      const code = stripComments(read(file));
      expect(code, file).not.toMatch(
        /WritableAdapter|connection\/write|WriteClient|applyChange|\.\.\/writes\/(rows|sql|structure|guard)/,
      );
    }
    // Only the catalog of the write path (read-only queries) is borrowed.
    expect(read("packages/postgres-adapter/src/validation/validate-rows.ts")).toMatch(
      /from "\.\.\/writes\/catalog\.js"/,
    );
  });

  it("is asked of an adapter only by the connection service, behind the data-access check", () => {
    const callers = appCode.filter((f) =>
      /\badapter\.validateRows\(/.test(readFileSync(f, "utf8")),
    );
    expect(callers.map(rel)).toEqual([rel(service)]);
    const routeCode = readFileSync(route, "utf8");
    expect(routeCode).toMatch(/connections\.validateRows\(/);
    expect(routeCode).not.toMatch(/adapter|writes\./i);
    const code = readFileSync(service, "utf8");
    const start = code.indexOf("validateRows(id: string");
    const body = code.slice(start, code.indexOf("unlinkProfile(", start));
    expect(start).toBeGreaterThan(-1);
    const refusal = body.indexOf("data_access_disabled");
    expect(refusal).toBeGreaterThan(-1);
    expect(body.indexOf("this.connections.use(")).toBeGreaterThan(refusal);
    expect(body.slice(0, refusal)).toMatch(/summary\.dataAccess/);
    expect(body).toContain("this.rowsGate.run(");
  });

  it("is a JSON POST with a strict body and no cache, and never writes to the console", () => {
    const routeCode = readFileSync(route, "utf8");
    expect(routeCode).toMatch(/export function POST\b/);
    expect(routeCode).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE|HEAD)\b/);
    expect(routeCode).toContain("jsonResponse");
    expect(routeCode).toContain("validateRequestSchema");
    expect(read("packages/shared-types/src/connections.ts")).toMatch(
      /validateRequestSchema = z\s*\.strictObject/,
    );
    for (const file of [
      "apps/web/app/api/connections/[id]/rows/validate/route.ts",
      "packages/postgres-adapter/src/validation/validate-rows.ts",
      "packages/postgres-adapter/src/connection/checking-transaction.ts",
      "packages/database-core/src/validation.ts",
      "apps/web/features/writes/validation-panel.tsx",
    ]) {
      expect(read(file), file).not.toMatch(/\bconsole\./);
    }
  });

  it("is not kept anywhere: not in the stores, the autosave or the saved layouts", () => {
    const places = [
      ...walk(path.join(root, "apps/web/stores")),
      ...walk(path.join(root, "apps/web/features/workspaces")),
      ...walk(path.join(root, "apps/web/features/canvas")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const file of places) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /validateRows|ValidationReport|validateRequestSchema|validationReportSchema/,
      );
    }
  });
});

describe("the pre-flight of a migration reads only counts, from names it checked", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const appCode = walk(path.join(root, "apps/web")).filter(
    (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("node_modules"),
  );
  const service = path.join(root, "apps/web/lib/server/connection-service.ts");
  const route = path.join(root, "apps/web/app/api/connections/[id]/rows/preflight/route.ts");

  it("is asked of an adapter only by the connection service, behind the data-access check", () => {
    const callers = appCode.filter((f) => /\badapter\.preflight\(/.test(readFileSync(f, "utf8")));
    expect(callers.map(rel)).toEqual([rel(service)]);
    const routeCode = readFileSync(route, "utf8");
    expect(routeCode).toMatch(/connections\.preflight\(/);
    expect(routeCode).not.toMatch(/adapter/i);
    const code = readFileSync(service, "utf8");
    const start = code.indexOf("preflight(id: string");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("unlinkProfile(", start));
    const refusal = body.indexOf("data_access_disabled");
    expect(refusal).toBeGreaterThan(-1);
    expect(body.indexOf("this.connections.use(")).toBeGreaterThan(refusal);
    expect(body.slice(0, refusal)).toMatch(/summary\.dataAccess/);
    expect(body).toContain("this.rowsGate.run(");
  });

  it("is a JSON POST with a strict body in which a check is a structure and never text that becomes SQL", () => {
    const routeCode = readFileSync(route, "utf8");
    expect(routeCode).toMatch(/export function POST\b/);
    expect(routeCode).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE|HEAD)\b/);
    expect(routeCode).toContain("preflightRequestSchema");
    const schema = read("packages/shared-types/src/connections.ts");
    expect(schema).toMatch(/preflightRequestSchema = z\.strictObject/);
    expect(schema).toMatch(/preflightCheckSchema = z\.discriminatedUnion\("kind"/);
    // Every kind is a strict object of names; there is no `sql`, `where` or `definition` in it.
    const checks = schema.slice(
      schema.indexOf("preflightCheckSchema"),
      schema.indexOf("preflightRequestSchema"),
    );
    expect(checks).not.toMatch(/\b(sql|where|definition|expression|text)\b/);
    expect((checks.match(/z\.strictObject/g) ?? []).length).toBe(4);
  });

  it("builds four fixed statements from catalog names, quoted, and returns only a count", () => {
    const code = stripComments(read("packages/postgres-adapter/src/introspection/preflight.ts"));
    const texts = (code.match(/`[^`]*`/g) ?? []).map((t) => t.replace(/\$\{[^}]*\}/g, ""));
    const statements = texts.filter((t) => /\bSELECT\b/.test(t));
    expect(statements.length).toBe(5); // nulls, duplicates (two parts), orphans (two parts), rows
    for (const t of texts) {
      expect(t, t).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER|COPY|GRANT)\b/);
    }
    // Every statement answers with a count (or a yes or no), never a column.
    expect(code).toMatch(/count\(\*\)::text AS n/);
    // The names are looked up in the catalog before any statement is built from them.
    expect(code).toMatch(/listTablesByRef\(db, \[\{ schema, name \}\]\)/);
    expect(code).toMatch(/ownNames\.every\(\(c\) => own\.has\(c\)\)/);
    expect(code).toMatch(/check\.refColumns\.every\(\(c\) => ref\.has\(c\)\)/);
    expect(code).not.toMatch(/\.message\b/);
  });

  it("makes its checks from the plan's steps and the structure, and never from the text of a constraint", () => {
    const code = stripComments(read("packages/database-core/src/migration/preflight.ts"));
    // The definition of a constraint (an expression) is never run, quoted or sent from here: the one use is to
    // look for two fixed words (NULLS NOT DISTINCT, MATCH FULL) with a regular expression, to say "not checked".
    const withoutWordTests = code.replace(/\/\\b[^/]+\/i\.test\(found\.definition \?\? ""\)/g, "");
    expect(withoutWordTests).not.toMatch(/\.definition\b/);
    expect(code).not.toMatch(/\.up\b|\.down\b/);
  });

  it("never writes to the console and is not kept anywhere", () => {
    for (const file of [
      "apps/web/app/api/connections/[id]/rows/preflight/route.ts",
      "packages/postgres-adapter/src/introspection/preflight.ts",
      "packages/database-core/src/migration/preflight.ts",
      "apps/web/features/migrations/preflight-panel.tsx",
      "apps/web/features/migrations/preflight-findings.ts",
    ]) {
      expect(read(file), file).not.toMatch(/\bconsole\./);
    }
    const places = [
      ...walk(path.join(root, "apps/web/stores")),
      ...walk(path.join(root, "apps/web/features/workspaces")),
      ...walk(path.join(root, "apps/web/features/canvas")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const file of places) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /preflight|PreflightResult|preflightRequestSchema/,
      );
    }
  });
});

describe("an export of rows is table data behind the data-access check, bounded, and leaves hidden columns out", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const appCode = walk(path.join(root, "apps/web")).filter(
    (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("node_modules"),
  );
  const service = path.join(root, "apps/web/lib/server/connection-service.ts");
  const route = path.join(root, "apps/web/app/api/connections/[id]/rows/export/route.ts");

  it("is asked of an adapter only by the connection service, behind the data-access check, one at a time", () => {
    const callers = appCode.filter((f) => /\badapter\.exportRows\(/.test(readFileSync(f, "utf8")));
    expect(callers.map(rel)).toEqual([rel(service)]);
    const routeCode = readFileSync(route, "utf8");
    expect(routeCode).toMatch(/connections\.exportRows\(/);
    expect(routeCode).not.toMatch(/adapter/i);
    const code = readFileSync(service, "utf8");
    const start = code.indexOf("async exportRows(");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("unlinkProfile(", start));
    const refusal = body.indexOf("data_access_disabled");
    expect(refusal).toBeGreaterThan(-1);
    // The adapter is reached through the registry (a call that prettier may put on two lines).
    const use = body.search(/this\.connections\s*\.use\(/);
    expect(use).toBeGreaterThan(refusal);
    expect(body.slice(0, refusal)).toMatch(/summary\.dataAccess/);
    // The export is registered only after the check, and before the adapter is reached.
    expect(body.indexOf("this.exporting.add(id)")).toBeGreaterThan(refusal);
    expect(body.indexOf("this.exporting.add(id)")).toBeLessThan(use);
    // One export at a time per connection, freed when it ends.
    expect(body).toMatch(/this\.exporting\.has\(id\)/);
    expect(body).toMatch(/this\.exporting\.delete\(id\)/);
    // The file stops at its size limit.
    expect(body).toContain("EXPORT_MAX_BYTES");
  });

  it("is a JSON POST with a strict body, answers with a file that is never cached or sniffed, and never writes to the console", () => {
    const routeCode = readFileSync(route, "utf8");
    expect(routeCode).toMatch(/export function POST\b/);
    expect(routeCode).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE|HEAD)\b/);
    expect(routeCode).toContain("exportRequestSchema");
    expect(routeCode).toContain('"Cache-Control": "no-store"');
    expect(routeCode).toContain('"X-Content-Type-Options": "nosniff"');
    expect(routeCode).toContain('"Content-Disposition": "attachment"');
    const schema = read("packages/shared-types/src/connections.ts");
    expect(schema).toMatch(/exportRequestSchema = z\.strictObject/);
    // The format is one of a fixed list, never free text; the limits are not in the request.
    expect(schema).toMatch(/format: z\.enum\(\["csv", "tsv", "json", "ndjson", "sql"\]\)/);
    // (The word "sql" is a value of the format list, the INSERT script of decision 167, and nothing else.)
    const body = schema
      .slice(schema.indexOf("exportRequestSchema"), schema.indexOf("ParsedExportRequest"))
      .replace(/format: z\.enum\(\[[^\]]*\]\)/, "format: <the fixed list>");
    expect(body).not.toMatch(/\b(limit|maxRows|maxBytes|sql|where|orderBy)\b/);
    for (const file of [
      "apps/web/app/api/connections/[id]/rows/export/route.ts",
      "packages/postgres-adapter/src/introspection/export-rows.ts",
      "packages/database-core/src/rows-export.ts",
    ]) {
      expect(read(file), file).not.toMatch(/\bconsole\./);
    }
  });

  it("reads through the page reader's own statement and checks, in the read-only transaction, and leaves a hidden column out", () => {
    const code = stripComments(read("packages/postgres-adapter/src/introspection/export-rows.ts"));
    // The same statement builder, the same check that a hidden column is neither sorted nor filtered.
    expect(code).toMatch(/buildRowsQuery\(/);
    expect(code).toMatch(/checkRowsSort\(requestedSort, columns, order\)/);
    expect(code).toMatch(/checkRowsFilters\(requestedFilters, columns\)/);
    // A column whose name looks sensitive is not read unless it was revealed, and is named as left out.
    expect(code).toMatch(/masked: isSensitiveColumnName\(c\.name\) && !reveal\.has\(c\.name\)/);
    expect(code).toMatch(
      /const shown = columns\.flatMap\(\(c, position\) => \(c\.masked \? \[\] :/,
    );
    expect(code).toMatch(/const leftOut = columns\.filter\(\(c\) => c\.masked\)/);
    // A cursor, fetched in batches; nothing that changes data; the row limit is the core's constant.
    expect(code).toMatch(/DECLARE dc_export NO SCROLL CURSOR FOR/);
    // The size of a fetch is a number the reader computes (at most `EXPORT_BATCH_ROWS`), never one from a request.
    expect(code).toMatch(/FETCH \$\{fetchRows\} FROM dc_export/);
    expect(code).toMatch(/Math\.min\(EXPORT_BATCH_ROWS, /);
    expect(code).toContain("limit: EXPORT_MAX_ROWS + 1");
    // A reader that stops reading cannot hold the transaction open for ever: the server ends it (and the
    // service gives up a write that waits for a stopped reader).
    expect(code).toContain("idle_in_transaction_session_timeout");
    expect(stripComments(read("apps/web/lib/server/connection-service.ts"))).toMatch(
      /Promise\.race\(\[\s*writer\.write\(chunk\)/,
    );
    // Batches are sized by what they hold, from a small first fetch.
    expect(code).toMatch(/let fetchRows = EXPORT_FIRST_BATCH_ROWS/);
    expect(code).not.toMatch(/ROWS_MAX_COLUMNS/);
    const texts = code.match(/`[^`]*`/g) ?? [];
    for (const t of texts) {
      expect(t.replace(/\$\{[^}]*\}/g, ""), t).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER|COPY|GRANT)\b/,
      );
    }
    expect(code).not.toMatch(/\.message\b/);
    // The page reader accepts the longer cell only through its plan, not from a request.
    expect(read("packages/postgres-adapter/src/introspection/rows.ts")).toMatch(
      /plan\.cellChars \?\? ROWS_CELL_CHARS/,
    );
  });

  it("makes every value of a spreadsheet format safe to open, and puts nothing about a value in the notes", () => {
    const code = stripComments(read("packages/database-core/src/rows-export.ts"));
    expect(code).toMatch(/defuse\(text\)/);
    // The notes name the table, the time, a count, column NAMES and conditions without values.
    const notes = code.slice(
      code.indexOf("function notes("),
      code.indexOf("function delimitedFormatter"),
    );
    expect(notes).not.toMatch(/\.value\b|\.values\b|\brows\[/);
    const service = stripComments(read("apps/web/lib/server/connection-service.ts"));
    expect(service).toMatch(
      /\.\.\.request\.filters\.map\(\(f\) => `\$\{f\.column\} \$\{f\.op\.replace/,
    );
  });

  it("is not kept anywhere: not in the stores, the autosave or the saved layouts", () => {
    const places = [
      ...walk(path.join(root, "apps/web/stores")),
      ...walk(path.join(root, "apps/web/features/workspaces")),
      ...walk(path.join(root, "apps/web/features/canvas")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const file of places) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /exportRows|exportRequestSchema|ExportEvent|rows-export/,
      );
    }
  });
});

describe("bulk row changes are many single-row changes in one transaction, never a new statement", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const rows = stripComments(read("packages/postgres-adapter/src/writes/rows.ts"));
  // The bulk planners (the import, the next section of the file, has its own rules below).
  const bulk = rows.slice(
    rows.indexOf("function distinctRows"),
    rows.indexOf("export function buildInsertBatch"),
  );

  it("builds every statement with the builders of one row, and asks about the rows with one fixed read", () => {
    const updatePlan = bulk.slice(
      bulk.indexOf("async function planUpdateRows"),
      bulk.indexOf("async function planDeleteRows"),
    );
    const deletePlan = bulk.slice(bulk.indexOf("async function planDeleteRows"), bulk.length);
    expect(updatePlan).toMatch(
      /buildUpdateRow\(change\.table, keys\[i\]!, set, change\.rows\[i\]!\.expected\)/,
    );
    expect(deletePlan).toMatch(/buildDeleteRow\(change\.table, keys\[i\]!\)/);
    // No text of SQL is written in the bulk code except through the builders: no template literal holds a statement.
    const texts = (bulk.match(/`[^`]*`/g) ?? []).map((t) => t.replace(/\$\{[^}]*\}/g, ""));
    for (const t of texts) expect(t, t).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)\b/);
    // The one question about a row is a SELECT built in one place, from a typed key and the values that were seen.
    const holds = rows.slice(
      rows.indexOf("export function buildRowStillHolds"),
      rows.indexOf("export function buildDeleteRow"),
    );
    // It asks which row a key finds (its table and position), so that two keys that find one row are refused.
    expect(holds).toContain("AS row_id FROM");
    expect(holds).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });

  it("requires every row to be changed exactly once or none: one_row per statement, in one transaction, a plan guard", () => {
    expect((bulk.match(/expect: "one_row"/g) ?? []).length).toBe(2);
    expect((bulk.match(/guard: \{ relations: \[guardRelation\(/g) ?? []).length).toBe(2);
    // Apply runs the plan's statements in order and rolls everything back on the first that is not exactly one row.
    const apply = stripComments(read("packages/postgres-adapter/src/writes/index.ts"));
    expect(apply).toMatch(/if \(count === 0\) throw new DatabaseError\("row_changed"\)/);
    expect(apply).toMatch(/if \(count !== 1\) throw new DatabaseError\("unexpected"\)/);
  });

  it("leaves out only rows that no longer hold what was seen, reports them before writing, and refuses when none is left", () => {
    expect(bulk).toMatch(/const \{ kept, skipped \} = await splitByCurrent\(/);
    expect(
      (bulk.match(/if \(kept\.length === 0\) throw new DatabaseError\("row_changed"\)/g) ?? [])
        .length,
    ).toBe(2);
    // The skipped positions are in the plan, and nothing else about them: no key, no value.
    expect((bulk.match(/\n\s+skipped,\n/g) ?? []).length).toBe(2);
    const service = stripComments(read("apps/web/lib/server/write-service.ts"));
    expect(service).toMatch(/skipped: plan\.skipped \?\? \[\]/);
  });

  it("refuses a row named twice and a request of more rows than the limit, in the schema and again in the planner", () => {
    const schema = stripComments(read("packages/shared-types/src/writes.ts"));
    expect(schema).toMatch(/WRITE_MAX_BULK_ROWS = 500/);
    expect(schema).toMatch(/\.max\(WRITE_MAX_BULK_ROWS\)/);
    expect(schema).toMatch(/distinctKeys\(c\.rows\)/);
    expect(bulk).toMatch(/if \(change\.rows\.length > MAX_BULK_ROWS\) throw invalidChange/);
    expect(bulk).toContain("distinctRows(keys)");
    // The strictness of the other operations: strict objects, no field that holds SQL.
    // From the bulk row schema to the insert schema that follows it (comments are stripped, so no marker is used).
    const bulkStart = schema.indexOf("const bulkRowSchema");
    const bulkEnd = schema.indexOf('z.literal("insert_rows")', bulkStart);
    expect(bulkStart).toBeGreaterThan(-1);
    expect(bulkEnd).toBeGreaterThan(bulkStart);
    const bulkSchemas = schema.slice(bulkStart, bulkEnd);
    expect(bulkSchemas).not.toMatch(/\b(sql|where|expression|using|returning)\b/);
    expect((bulkSchemas.match(/z\s*\.strictObject/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("is reached only through the write service, as every other row change is", () => {
    const callers = walk(path.join(root, "apps/web"))
      .filter(
        (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("node_modules"),
      )
      .filter((f) => /\.previewChange\(|\.applyChange\(/.test(readFileSync(f, "utf8")));
    expect(callers.map(rel)).toEqual(["apps/web/lib/server/write-service.ts"]);
  });
});

describe("an import is batches of one fixed statement with every value bound, and the file never names anything", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const rows = stripComments(read("packages/postgres-adapter/src/writes/rows.ts"));
  const insert = rows.slice(
    rows.indexOf("export function buildInsertBatch"),
    rows.indexOf("export function planRowChange"),
  );

  it("the statement is built in one place, from catalog names and one array parameter per column", () => {
    // The single row's two forms (with values, and DEFAULT VALUES), and the batch's, which is the only one in the import.
    expect((rows.match(/INSERT INTO/g) ?? []).length).toBe(3);
    expect((insert.match(/INSERT INTO/g) ?? []).length).toBe(1);
    const builder = insert.slice(0, insert.indexOf("async function planInsertRows"));
    expect(builder).toContain("quoteQualified(table.schema, table.name)");
    expect(builder).toContain("quoteIdentifier(c.column)");
    expect(builder).toContain("$${i + 1}::text[]");
    expect(builder).toContain("unnest(");
    // A value is never part of the text: only names, casts and the numbers of parameters are.
    const text = builder.slice(builder.indexOf("text:"), builder.indexOf("values:"));
    expect(text).not.toMatch(/\brows\b|\br\[/);
    expect(builder).toContain("expectRows: rows.length");
  });

  it("the columns and their types come from the catalog, and only a column that can be written", () => {
    const plan = insert.slice(insert.indexOf("async function planInsertRows"));
    expect(plan).toContain("requireEditable(db, change.table)");
    expect(plan).toContain("findColumn(table, name)");
    expect(plan).toContain("requireWritable(column)");
    expect(plan).toContain("castType: column.castType");
    expect(plan).toMatch(/change\.rows\.length > IMPORT_MAX_ROWS/);
    expect(plan).toMatch(/new Set\(change\.columns\)\.size !== change\.columns\.length/);
  });

  it("applying checks the rows each batch added and honours a cancel between batches", () => {
    const index = stripComments(read("packages/postgres-adapter/src/writes/index.ts"));
    expect(index).toMatch(/signal\?\.aborted/);
    expect(index).toMatch(/statement\.expectRows !== undefined && count !== statement\.expectRows/);
  });

  it("the schema is strict and bounded, with the limits of the core", () => {
    const schema = read("packages/shared-types/src/writes.ts");
    const start = schema.indexOf("export const insertRowsChangeSchema");
    const part = schema.slice(start, schema.indexOf("// ----", start));
    expect(part).toMatch(/z\s*\.strictObject/);
    expect(part).not.toMatch(/\b(sql|where|expression|using|returning)\b/);
    expect(part).toContain("WRITE_MAX_IMPORT_ROWS");
    expect(part).toContain("WRITE_MAX_IMPORT_COLUMNS");
    expect(part).toContain("WRITE_MAX_IMPORT_CELL_CHARS");
  });

  it("the file is read in the browser: no server code parses it, and a name in it builds nothing", () => {
    const server = [
      ...walk(path.join(root, "apps/web/app")),
      ...walk(path.join(root, "apps/web/lib/server")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const file of server) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /csv-parse|parseCsv|features\/import/,
      );
    }
    // The names of the file are compared with the table's to suggest a choice; the change is built from the choice.
    const plan = stripComments(read("apps/web/features/import/import-plan.ts"));
    const built = plan.slice(
      plan.indexOf("export function buildImport"),
      plan.indexOf("export function previewRows"),
    );
    expect(built).not.toMatch(/header\b/);
    expect(built).toContain("columns.push(column)");
    expect(stripComments(read("apps/web/features/import/import-dialog.tsx"))).toContain(
      "buildImport(",
    );
  });

  it("a cancel is looked at again before the commit, two keys that find one row are refused, and no text of a request can hold half a character", () => {
    const index = stripComments(read("packages/postgres-adapter/src/writes/index.ts"));
    // After the loop of statements, before `return { rowCount }`, which is what the caller commits on.
    expect(index).toMatch(/\}\s*if \(signal\?\.aborted\)[\s\S]*?return \{ rowCount \};/);
    expect(rows).toContain("tableoid::text || ':' || ctid::text AS row_id");
    expect(rows).toContain('if (repeated) throw invalidChange("A row is listed twice.")');
    const schema = read("packages/shared-types/src/writes.ts");
    expect((schema.match(/\.refine\(wellFormed, WELL_FORMED\)/g) ?? []).length).toBe(4);
  });

  it("the preview store keeps at most two imports per connection", () => {
    const store = stripComments(read("apps/web/lib/server/preview-store.ts"));
    expect(store).toMatch(/MAX_IMPORT_PREVIEWS_PER_CONNECTION = 2/);
    expect(store).toContain('plan.change.kind === "insert_rows"');
  });

  it("is kept nowhere: not in the stores, the autosave or the saved layouts", () => {
    const places = [
      ...walk(path.join(root, "apps/web/stores")),
      ...walk(path.join(root, "apps/web/features/workspaces")),
      ...walk(path.join(root, "apps/web/features/canvas")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const file of places) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /features\/import|insert_rows|csv-parse/,
      );
    }
  });
});

describe("a sort and conditions never become SQL text", () => {
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");

  it("the request schema is strict all the way down: the request, the sort and every condition", () => {
    const code = read("packages/shared-types/src/connections.ts");
    expect(code).toMatch(/rowsRequestSchema = z\s*\.strictObject/);
    expect(code).toMatch(/rowSortSchema = z\s*\.strictObject/);
    // A condition: strict, and its operator one of a fixed list, never free text (`row-filters.ts`).
    const filters = read("packages/shared-types/src/row-filters.ts");
    expect(filters).toMatch(/rowFilterSchema = z\s*\.strictObject/);
    expect(filters).toMatch(/op: z\.enum\(ROW_FILTER_OPERATORS\)/);
    // Every list in a condition is bounded.
    expect(filters).toMatch(/values: z\.array\(text\)\.max\(MAX_ROW_FILTER_VALUES\)/);
    expect(filters).toMatch(/\.max\(MAX_ROW_FILTER_PATH\)/);
  });

  it("the service passes both to the adapter untouched: structured data, no text is built from them", () => {
    const code = stripComments(read("apps/web/lib/server/connection-service.ts"));
    const start = code.indexOf("getRows(id: string");
    // Up to the next method (one cell, a validation, a pre-flight and an export follow, each with its own rules).
    const end = code.indexOf("getCell(id: string", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = code.slice(start, end);
    expect(body).toContain("sort: request.sort");
    expect(body).toContain("filters: request.filters");
    expect(body).not.toMatch(/`|JSON\.stringify|\.join\(|\+ *request\./);
  });

  it("the statement writes each operator from a fixed table, by its own keys, and never uses LIKE", () => {
    const raw = read("packages/postgres-adapter/src/introspection/rows.ts");
    const code = stripComments(raw);
    // Own keys only: a plain object also answers to "toString" and "__proto__".
    expect(code).toContain("Object.hasOwn(NONE_SQL");
    expect(code).toContain("Object.hasOwn(ONE_SQL");
    // LIKE would make a % or _ in a value a wildcard; contains and starts with are strpos and starts_with.
    expect(code).not.toMatch(/\b(I?LIKE|SIMILAR TO)\b/i);
    // The one regular-expression operator is `matches`, and its pattern is a bound parameter cast to text.
    const regex = code.match(/~\*?\s/g) ?? [];
    expect(regex).toHaveLength(1);
    expect(code).toContain("~* CAST(${p} AS text)");
    // Every value of a condition goes through the parameter function.
    expect(code).toMatch(/ONE_SQL\[op\]!\(c, param\(filter\.value\)\)/);
  });

  it("no value, list or path of a condition is ever written into the statement's text", () => {
    const code = stripComments(read("packages/postgres-adapter/src/introspection/rows.ts"));
    // A `${...}` that holds a request value would put it in the text; each must be inside `param(`.
    for (const match of code.matchAll(
      /\$\{[^}]*\b(?:filter\.(?:value|values|path)|values\[\d\])[^}]*\}/g,
    )) {
      expect(match[0], match[0]).toMatch(/param\(/);
    }
  });

  it("keeps rows out of everything that is saved: workspaces, snapshots and profiles have no place for them", () => {
    for (const file of [
      "packages/shared-types/src/workspace.ts",
      "packages/shared-types/src/snapshots.ts",
      "packages/shared-types/src/profiles.ts",
    ]) {
      const code = readFileSync(path.join(root, file), "utf8");
      expect(code, file).not.toMatch(/rowPageSchema|RowPage|RowCell|rowsResponseSchema/);
    }
  });
});

describe("rows in the browser live in component state only", () => {
  const web = path.join(root, "apps/web");
  const notTest = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f);
  const dataFiles = walk(path.join(web, "features/data")).filter(notTest);
  /** The code of a file without its comments (a comment may say "never stored in localStorage"). */
  const code = (file: string) =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("finds the data viewer files", () => {
    expect(dataFiles.length).toBeGreaterThan(5);
  });

  it("only saved filter shapes may touch localStorage, and they keep no value", () => {
    const users = dataFiles.filter((f) => code(f).includes("localStorage")).map(rel);
    expect(users).toEqual([rel(path.join(web, "features/data/filter-shapes.ts"))]);
    // A shape is the columns, conditions and groups; the filter's value, list and path are never read.
    const shapes = code(path.join(web, "features/data/filter-shapes.ts"));
    expect(shapes).not.toMatch(/\b(?:f|filter)\.(?:value|values|path)\b/);
  });

  it.each(["sessionStorage", "indexedDB", "document.cookie", "caches.", "persist("])(
    "the data viewer never touches %s",
    (api) => {
      for (const file of dataFiles) expect(code(file), rel(file)).not.toContain(api);
    },
  );

  it("only the rows hook asks for rows, and it holds them in React state", () => {
    const callers = walk(path.join(web, "features"))
      .filter(notTest)
      .filter((f) => /\bgetRows\(/.test(code(f)));
    expect(callers.map(rel)).toEqual(
      [
        rel(path.join(web, "features/data/api.ts")),
        rel(path.join(web, "features/data/use-rows.ts")),
      ].sort(),
    );
    const hook = code(path.join(web, "features/data/use-rows.ts"));
    expect(hook).toMatch(/useState|useReducer/);
    expect(hook).not.toMatch(/zustand|create\(/);
  });

  it("the stores, the autosave and the saved layouts never see a page of rows", () => {
    const places = [
      ...walk(path.join(web, "stores")),
      ...walk(path.join(web, "features/workspaces")),
      ...walk(path.join(web, "features/canvas")),
    ].filter(notTest);
    expect(places.length).toBeGreaterThan(5);
    for (const file of places) {
      expect(code(file), rel(file)).not.toMatch(
        /\bgetRows\b|\bRowPage\b|\bRowCell\b|rowsResponseSchema|features\/data\/use-rows|\bRowFilter\b|\bRowSort\b|rowFilterSchema|rowSortSchema/,
      );
    }
  });

  it("the data viewer does not write to the console", () => {
    for (const file of dataFiles) expect(code(file), rel(file)).not.toMatch(/\bconsole\./);
  });
});

describe("the documents tell the truth about rows", () => {
  // Product-wide texts. Statements about ONE tab ("this tab reads no table rows") are fine and are
  // not listed here: they describe that tab, not the product.
  const documents = [
    "README.md",
    "SECURITY.md",
    "docs/getting-started.md",
    "docs/threat-model.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    "apps/web/features/connections/connection-form.tsx",
  ];
  const text = (file: string) => readFileSync(path.join(root, file), "utf8");

  it.each(documents)("%s does not say that rows are never read", (file) => {
    const content = text(file).replace(/\s+/g, " ");
    expect(content).not.toMatch(/never reads? (any )?(table )?rows/i);
    expect(content).not.toMatch(/(table )?rows are never read/i);
    expect(content).not.toMatch(/only reads? (the )?metadata/i);
    expect(content).not.toMatch(/never (reads|its) rows/i);
  });

  it.each(["README.md", "SECURITY.md", "docs/getting-started.md", "docs/threat-model.md"])(
    "%s describes data viewing",
    (file) => {
      expect(text(file).toLowerCase()).toContain("data viewing");
    },
  );

  it("the guide and the threat model describe sorting and filtering, and SECURITY.md says what they cost", () => {
    for (const file of ["docs/getting-started.md", "docs/threat-model.md"]) {
      const content = text(file).toLowerCase();
      expect(content, file).toContain("sort");
      expect(content, file).toContain("filter");
    }
    const security = text("SECURITY.md").replace(/\s+/g, " ");
    // A heavy sort or condition is bounded, and the document says by how much.
    expect(security).toMatch(/5 seconds/);
    // A condition on a hidden column would read it back, so the document says it is refused.
    expect(security.toLowerCase()).toMatch(/hidden column is refused/);
  });

  it("the README and SECURITY.md say it is off by default and that rows are never saved", () => {
    for (const file of ["README.md", "SECURITY.md"]) {
      const content = text(file).replace(/\s+/g, " ").toLowerCase();
      expect(content, file).toContain("off by default");
      expect(content, file).toMatch(/never (written to a file|saved)/);
    }
  });
});

describe("writes: the documents say what the promise now is", () => {
  const flat = (file: string) =>
    readFileSync(path.join(root, file), "utf8").replace(/\s+/g, " ").toLowerCase();

  it("the README says DataCanvas never changes a database unless started with --enable-writes", () => {
    const readme = flat("README.md");
    expect(readme).toContain(
      "never changes your database unless you start it with `--enable-writes`",
    );
    expect(readme).toContain("--enable-writes allow editing rows");
  });

  it("SECURITY.md names the three switches, what local cannot prove, and that a change cannot be undone", () => {
    const security = flat("SECURITY.md");
    expect(security).toContain("--enable-writes");
    expect(security).toMatch(/on this machine/);
    expect(security).toMatch(/typ(e|ing) its database name/);
    expect(security).toMatch(/tunnel/);
    expect(security).toMatch(/cannot be undone/);
    expect(security).toMatch(/cascade/);
  });

  it("the threat model and the guide describe writes", () => {
    const model = flat("docs/threat-model.md");
    expect(model).toContain("changing the database (writes");
    expect(model).toContain("no `cascade`");
    const guide = flat("docs/getting-started.md");
    expect(guide).toContain("--enable-writes");
    expect(guide).toContain("cannot be undone");
  });

  it("no product document says DataCanvas only reads, without a qualifier beside it", () => {
    // "DataCanvas only reads ..." was true until 1.4.0. It must now be said with its condition.
    const claim = /datacanvas (only|never) (reads|writes|changes)\b/g;
    const qualifier = /--enable-writes|by default|unless/;
    for (const file of ["README.md", "SECURITY.md", "docs/getting-started.md"]) {
      const content = flat(file);
      for (const match of content.matchAll(claim)) {
        const around = content.slice(Math.max(0, match.index - 160), match.index + 200);
        expect(around, `${file}: "${match[0]}"`).toMatch(qualifier);
      }
      expect(content, file).not.toMatch(/there is no way to (change|modify|write)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Writes (1.4.0): editing rows and designing tables, docs/data-editing-plan.md.
// ---------------------------------------------------------------------------

/** The text of a source file without its comments, so a rule reads code and not prose. */
function codeOf(file: string): string {
  return readFileSync(path.join(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const writeRoutes = routeFiles.filter(
  (f) => f.includes(`${path.sep}writes${path.sep}`) || f.includes(`${path.sep}role${path.sep}`),
);

describe("writes: every route is guarded, JSON only and never cached", () => {
  it("finds the nine routes", () => {
    expect(writeRoutes.map(rel).sort()).toEqual(
      [
        "apps/web/app/api/connections/[id]/role/route.ts",
        "apps/web/app/api/connections/[id]/writes/apply/route.ts",
        "apps/web/app/api/connections/[id]/writes/edit-info/route.ts",
        "apps/web/app/api/connections/[id]/writes/history/route.ts",
        "apps/web/app/api/connections/[id]/writes/lock/route.ts",
        "apps/web/app/api/connections/[id]/writes/migration/route.ts",
        "apps/web/app/api/connections/[id]/writes/preview/route.ts",
        "apps/web/app/api/connections/[id]/writes/route.ts",
        "apps/web/app/api/connections/[id]/writes/unlock/route.ts",
      ].sort(),
    );
  });

  it.each(writeRoutes.map((f) => [rel(f)]))(
    "%s uses handleRoute and no-store, and has no console",
    (file) => {
      const source = codeOf(file as string);
      expect(source).toMatch(/handleRoute\(\s*request\b/);
      expect(source).toContain("jsonResponse"); // Cache-Control: no-store
      expect(source).not.toMatch(/\bconsole\./);
      expect(source).not.toMatch(/Response\.json|new Response\(/); // always through jsonResponse
    },
  );

  it("a route either reads (GET) or takes a strict JSON body (POST), and nothing else", () => {
    for (const file of writeRoutes) {
      const source = codeOf(rel(file));
      const isRead = /export function GET\b/.test(source);
      const isPost = /export function POST\b/.test(source);
      expect(isRead !== isPost, rel(file)).toBe(true);
      expect(source, rel(file)).not.toMatch(/export (async )?function (PUT|PATCH|DELETE|HEAD)\b/);
      if (isPost) expect(source, rel(file)).toMatch(/parseJsonBody\(\s*request,\s*\w*Schema/);
    }
  });

  it("preview and apply use the strict request schemas", () => {
    expect(codeOf("apps/web/app/api/connections/[id]/writes/apply/route.ts")).toContain(
      "applyChangeRequestSchema",
    );
    expect(codeOf("apps/web/app/api/connections/[id]/writes/preview/route.ts")).toContain(
      "previewChangeRequestSchema",
    );
  });
});

describe("writes: only the write service reaches the write capability", () => {
  const appCode = walk(path.join(root, "apps/web")).filter(
    (f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("node_modules"),
  );
  const writeService = "apps/web/lib/server/write-service.ts";

  it("is used in apps/web by lib/server/write-service.ts alone", () => {
    const users = appCode.filter((f) =>
      /\b(WritableAdapter|isWritableAdapter|previewChange|applyChange)\b/.test(codeOf(rel(f))),
    );
    expect(users.map(rel)).toEqual([writeService]);
  });

  it("the UI never imports the write service", () => {
    for (const file of appCode.filter((f) => /\/(features|components|stores)\//.test(f))) {
      expect(codeOf(rel(file)), rel(file)).not.toMatch(/write-service|WriteService/);
    }
  });

  it("snapshots, structure capture and every read path never plan or apply a change", () => {
    for (const file of [
      "apps/web/lib/server/snapshot-service.ts",
      "apps/web/lib/server/connection-service.ts",
      "apps/web/lib/server/workspace-service.ts",
      "apps/web/lib/server/profile-service.ts",
      "apps/web/lib/server/rows-gate.ts",
      "packages/database-core/src/structure.ts",
      "packages/database-core/src/diff.ts",
      "packages/database-core/src/rows.ts",
    ]) {
      expect(codeOf(file), file).not.toMatch(
        /\b(previewChange|applyChange|describeForEdit|WritableAdapter|isWritableAdapter)\b/,
      );
    }
  });

  it("checks the switches in order: the flag, a local database, data viewing, then the name", () => {
    const source = codeOf(writeService);
    // The three switches are checked in one method, in this order ...
    const start = source.indexOf("private requireSwitches(");
    const switches = source.slice(start, source.indexOf("private requireUnlocked(", start));
    const order = ["writes_not_enabled", "writes_not_allowed_here", "data_access_disabled"].map(
      (name) => switches.indexOf(`"${name}"`),
    );
    expect(start).toBeGreaterThan(-1);
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // ... and the unlock checks the name only after all of them.
    const unlock = source.slice(source.indexOf("  unlock("), source.indexOf("  lock("));
    expect(unlock.indexOf("this.requireSwitches(")).toBeGreaterThan(-1);
    expect(unlock.indexOf('"wrong_database_name"')).toBeGreaterThan(
      unlock.indexOf("this.requireSwitches("),
    );
    // Every operation re-checks the switches rather than trusting an earlier answer.
    expect(source.match(/requireUnlocked\(|requireSwitches\(/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("takes the preview out of the store before it runs, so it can be used once", () => {
    const source = codeOf(writeService);
    const take = source.indexOf("this.previews.take(");
    const run = source.indexOf("applyChange(plan, signal)");
    expect(take).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(take);
  });

  it("the flag reaches the server only from the CLI's environment, never from a request", () => {
    expect(codeOf("apps/web/lib/security/request-guard.ts")).toContain(
      'env[ENABLE_WRITES_ENV] === "1"',
    );
    for (const file of appCode.filter((f) => /app\/api/.test(rel(f)))) {
      expect(codeOf(rel(file)), rel(file)).not.toMatch(/writesEnabled|ENABLE_WRITES/);
    }
    // The CLI drops a value inherited from the shell, in every spelling (Windows environment
    // names ignore case): only the flag can turn writes on.
    expect(codeOf("packages/cli/src/web-server.ts")).toMatch(
      /key\.toLowerCase\(\) === ENABLE_WRITES_ENV\.toLowerCase\(\)\) delete rest\[key\]/,
    );
  });

  it("the unlock is memory only: no saved or shared type has a place for it", () => {
    for (const file of [
      "packages/shared-types/src/profiles.ts",
      "packages/shared-types/src/workspace.ts",
      "packages/shared-types/src/snapshots.ts",
      "packages/shared-types/src/postgres-connection.ts",
      "packages/shared-types/src/connections.ts",
    ]) {
      expect(codeOf(file), file).not.toMatch(/unlock|writeUnlocked/i);
    }
  });
});

describe("writes: no value of a change is ever logged or recorded", () => {
  /** The write path: the files that see a change and its values. */
  const writePath = [
    "apps/web/lib/server/write-service.ts",
    "apps/web/lib/server/preview-store.ts",
    "packages/database-core/src/changes.ts",
    "packages/database-core/src/testing/mock-writes.ts",
    "packages/shared-types/src/writes.ts",
    // The PostgreSQL adapter's write code, once it exists.
    ...walk(path.join(root, "packages/postgres-adapter/src"))
      .map(rel)
      .filter((f) => /\/writes\//.test(f) || /role-info\.ts$/.test(f))
      .filter((f) => !/\.test\.ts$/.test(f)),
  ];

  it.each(writePath.map((f) => [f]))("%s never writes to the console", (file) => {
    expect(codeOf(file as string)).not.toMatch(/\bconsole\./);
  });

  it("the history entry has no field that could hold a value", () => {
    const source = codeOf("packages/shared-types/src/writes.ts");
    const start = source.indexOf("export const historyEntrySchema");
    const end = source.indexOf("});", start);
    expect(start).toBeGreaterThan(-1);
    const keys = [...source.slice(start, end).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      "id",
      "at",
      "kind",
      "table",
      "columns",
      "statement",
      "outcome",
      "errorCode",
    ]);
  });

  it("the service records a change by its kind, table, column names and outcome only", () => {
    const source = codeOf("apps/web/lib/server/write-service.ts");
    const start = source.indexOf("private record(");
    const body = source.slice(start, source.indexOf("return entry;", start));
    expect(start).toBeGreaterThan(-1);
    // Nothing of the change's values is read when the entry is made.
    expect(body).not.toMatch(/change\.(values|set|expected|key)\b/);
    expect(body).not.toMatch(/\.statements\b|\.value\b/);
    // The SQL (which holds `$1`, never a value) is kept for a change of structure only.
    expect(body).toMatch(/category === "structure"/);
  });

  it("the preview answer carries the statement text and no parameters", () => {
    const source = codeOf("apps/web/lib/server/write-service.ts");
    const start = source.indexOf("async preview(");
    const body = source.slice(start, source.indexOf("expiresAt: new Date", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("statementText(plan)");
    expect(body).not.toMatch(/\.values\b/);
  });
});

describe("writes: no request carries SQL", () => {
  const source = codeOf("packages/shared-types/src/writes.ts");

  it("no schema has a key named sql, where, expression, using, returning or query", () => {
    expect([...source.matchAll(/\b(sql|where|expression|using|returning|query)\s*:/g)]).toEqual([]);
  });

  it("every object in a request is strict", () => {
    // Everything before the first response schema is a request or a part of one.
    const requests = source.slice(0, source.indexOf("export const writesStatusSchema"));
    expect(requests.length).toBeGreaterThan(1000);
    expect(requests).not.toMatch(/\bz\.object\(/);
    expect(requests).toMatch(/z\.strictObject\(/);
  });

  it("the change kinds are a closed list of structured operations", () => {
    const kinds = [...source.matchAll(/kind:\s*z\.literal\("(\w+)"\)/g)].map((m) => m[1]!);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "update_row",
        "insert_row",
        "delete_row",
        "create_table",
        "drop_table",
        "drop_column",
      ]),
    );
    for (const kind of kinds) expect(kind).not.toMatch(/sql|query|exec|raw|run/);
  });

  it("the statement code puts values in the parameter list and never matches with LIKE", () => {
    const mock = codeOf("packages/database-core/src/testing/mock-writes.ts");
    expect(mock).toMatch(/values\.push\(value\)/);
    expect(mock).not.toMatch(/\b(LIKE|ILIKE|SIMILAR TO)\b/);
  });
});

describe("the Content-Security-Policy is made for each request and nothing in the page runs without it", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const sources = walk(path.join(root, "apps/web")).filter(
    (f) =>
      /\.(ts|tsx)$/.test(f) &&
      !/\.test\.tsx?$/.test(f) &&
      !f.includes("node_modules") &&
      !f.includes("/.next/") &&
      !f.includes("/dist/"),
  );

  it("the proxy gives every page a policy with a new nonce, on the request (for the framework) and the response", () => {
    const proxy = read("apps/web/proxy.ts");
    expect(proxy).toContain("makeNonce()");
    expect(proxy).toContain("buildCsp(nonce");
    expect(proxy).toMatch(/headers\.set\("Content-Security-Policy", policy\)/);
    expect(proxy).toMatch(/headers\.set\("x-nonce", nonce\)/);
    expect(proxy).toMatch(/response\.headers\.set\("Content-Security-Policy", policy\)/);
    // The nonce is made inside the function that serves a request: a constant would be the same for every page.
    expect(proxy.slice(0, proxy.indexOf("export function proxy"))).not.toMatch(/makeNonce\(\)/);
  });

  it("the one script of ours has the nonce, and no other component writes a script", () => {
    expect(read("apps/web/app/layout.tsx")).toMatch(/<script nonce=\{nonce\}/);
    for (const file of sources) {
      const code = readFileSync(file, "utf8");
      if (file.endsWith("app/layout.tsx")) continue;
      expect(code, rel(file)).not.toMatch(/<script\b|next\/script/i);
      expect(code, rel(file)).not.toMatch(/\bdangerouslySetInnerHTML\b/);
    }
  });

  it("no code of the app compiles code from text (eval, new Function), which the policy would refuse", () => {
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    }
  });

  it("the browser is told not to ask zod for code generation, before any response is parsed", () => {
    expect(read("apps/web/lib/zod-config.ts")).toContain("z.config({ jitless: true })");
    expect(read("apps/web/lib/api-client.ts")).toMatch(/^import "@\/lib\/zod-config";/m);
    expect(read("apps/web/app/layout.tsx")).toContain("<BrowserSetup />");
  });

  it("the policy has no unsafe-inline for scripts and no eval outside development", () => {
    const code = read("apps/web/lib/security/csp.ts");
    const scriptSrc = code.slice(code.indexOf('"script-src"'), code.indexOf('"style-src"'));
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect((scriptSrc.match(/unsafe-eval/g) ?? []).length).toBe(1);
    expect(scriptSrc).toMatch(/options\.dev \? \["'unsafe-eval'"\]/);
  });
});

describe("a query plan lives in the tab's memory like a result", () => {
  const root2 = root;
  const read = (file: string) => readFileSync(path.join(root2, file), "utf8");

  it("is kept in no store, no autosave, no saved layout and no file", () => {
    const places = [
      ...walk(path.join(root, "apps/web/stores")),
      ...walk(path.join(root, "apps/web/features/workspaces")),
      ...walk(path.join(root, "apps/web/features/canvas")),
      ...walk(path.join(root, "apps/web/features/snapshots")),
      ...walk(path.join(root, "apps/web/lib")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const file of places) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /features\/sql\/plan|planFromRows|parsePlan|PlanResultView/,
      );
    }
  });

  it("is never written anywhere by its own code: no storage, no network, no download", () => {
    for (const file of ["apps/web/features/sql/plan.ts", "apps/web/features/sql/plan-view.tsx"]) {
      expect(read(file), file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|createObjectURL|document\.cookie/,
      );
    }
  });

  it("is read as untrusted text: bounded, and never put into the page as markup", () => {
    const parser = read("apps/web/features/sql/plan.ts");
    expect(parser).toContain("PLAN_MAX_NODES");
    expect(parser).toContain("PLAN_MAX_DEPTH");
    expect(parser).toContain("SQL_LIMITS.maxPlanChars");
    expect(read("apps/web/features/sql/plan-view.tsx")).not.toMatch(
      /dangerouslySetInnerHTML|innerHTML/,
    );
  });

  it("the runner keeps a plan whole only when it is one cell of an EXPLAIN, and refuses a larger one", () => {
    const runner = read("packages/postgres-adapter/src/connection/run-statement.ts");
    expect(runner).toContain("isWholePlan(raw.command, kept)");
    expect(runner).toContain("PLAN_TOO_LARGE_MESSAGE");
    expect(runner).toContain("wholePlan ? { rows: kept, cutCells: 0 } : cutLongCells(kept)");
  });
});

describe("the statistics of a table hold no value of the table", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("no statement of the adapter names a statistic that holds values (pg_stats keeps the values of the table in them)", () => {
    const FORBIDDEN =
      /most_common_vals|most_common_freqs|most_common_elems|most_common_elem_freqs|histogram_bounds|elem_count_histogram|range_length_histogram|range_bounds_histogram|stavalues|stanumbers|pg_statistic\b|pg_statistic_ext|pg_stats_ext|stxdmcv|stxdndistinct/;
    const sources = walk(path.join(root, "packages/postgres-adapter/src")).filter(
      (f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("/dist/"),
    );
    for (const file of sources) {
      expect(stripComments(readFileSync(file, "utf8")), rel(file)).not.toMatch(FORBIDDEN);
    }
  });

  it("the statistics read names the columns it takes and never selects everything from pg_stats", () => {
    const code = stripComments(read("packages/postgres-adapter/src/introspection/statistics.ts"));
    expect(code).not.toMatch(/\bs\.\*|SELECT\s+\*|pg_stats\.\*/);
    for (const column of ["null_frac", "n_distinct", "avg_width", "correlation"]) {
      expect(code).toContain(`s.${column}`);
    }
  });

  it("the route reads no row, so it does not need the data-access switch, and says so", () => {
    const route = read("apps/web/app/api/connections/[id]/tables/[table]/statistics/route.ts");
    expect(route).toContain("No row and no value is read");
    expect(route).not.toMatch(/requireDataAccess|dataAccess/);
    // It only reads through the adapter's statistics method: no row reader.
    expect(route).toContain("getTableStatistics(");
    expect(route).not.toMatch(/getRows|exportRows|getCell|runStatement/);
  });
});

describe("the documentation exports are made in the browser from the structure, and name nothing as syntax", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const files = walk(path.join(root, "apps/web/features/docs")).filter(
    (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f),
  );

  it("the generators are pure: no network, no storage, no row reader, no framework", () => {
    for (const file of files.filter((f) => !f.endsWith("docs-export-dialog.tsx"))) {
      const code = readFileSync(file, "utf8");
      expect(code, rel(file)).not.toMatch(
        /fetch\(|localStorage|sessionStorage|indexedDB|XMLHttpRequest|from "react"|getRows|exportRows|getCell|runStatement/,
      );
    }
  });

  it("the dialog reads only the structure (schemas, tables, table details, relationships), never a row", () => {
    const dialog = read("apps/web/features/docs/docs-export-dialog.tsx");
    for (const call of ["getSchemas(", "getTables(", "getTablesDetails(", "getRelationships("]) {
      expect(dialog).toContain(call);
    }
    expect(dialog).not.toMatch(
      /features\/data\/|getRows|exportRows|getCell|validateRows|runStatement/,
    );
    // The file is made and saved by the browser: no upload.
    expect(dialog).toContain("URL.createObjectURL");
    expect(dialog).not.toMatch(/fetch\(|method: "POST"/);
  });

  it("every name goes through a quoting function of quote.ts before it is written", () => {
    for (const name of ["markdown", "mermaid", "dbml", "plantuml"]) {
      const code = read(`apps/web/features/docs/${name}.ts`);
      expect(code, name).toContain('from "./quote"');
    }
    // No generator writes a template literal with a raw `.name` straight into a line.
    const mermaid = read("apps/web/features/docs/mermaid.ts");
    expect(mermaid).not.toMatch(/\$\{c\.name\}|\$\{entry\.table\.name\}/);
  });
});

describe("an export of chosen rows names rows by the whole key and is read by the page reader's own statement", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the keys of the request are strict and bounded: 500 keys of up to 32 parts, a value of 4,096 characters", () => {
    const code = read("packages/shared-types/src/connections.ts");
    const part = code.slice(
      code.indexOf("exportRequestSchema = z.strictObject"),
      code.indexOf("ParsedExportRequest"),
    );
    expect(part).toMatch(
      /keys: z\s*\.array\(\s*z\s*\.array\(z\.strictObject\(\{ column: identifierSchema, value: z\.string\(\)\.max\(4096\) \}\)\)\s*\.min\(1\)\s*\.max\(32\),?\s*\)\s*\.min\(1\)\s*\.max\(500\)\s*\.optional\(\)/,
    );
  });

  it("the adapter checks the keys against the catalog's key before the statement is built", () => {
    const code = stripComments(read("packages/postgres-adapter/src/introspection/export-rows.ts"));
    expect(code).toContain("checkKeys(options.keys, columns, order.columns, reveal)");
    expect(code).toMatch(/keyColumns\.length === 0\) throw new DatabaseError\("not_supported"\)/);
    expect(code).toMatch(/isSensitiveColumnName\(name\) && !reveal\.has\(name\)/);
    expect(code).toMatch(/byName\.size !== keyColumns\.length/);
    expect(code).toContain("EXPORT_MAX_KEYS");
  });

  it("the keys reach the statement only as bound values, in the page reader's one builder", () => {
    const code = stripComments(read("packages/postgres-adapter/src/introspection/rows.ts"));
    const at = code.indexOf("plan.keys && plan.keys.length > 0");
    expect(at).toBeGreaterThan(-1);
    const part = code.slice(at, at + 420);
    expect(part).toContain("param(value)");
    expect(part).toContain("ROW(${keyList}) IN (");
    // No value is written into the text: nothing but `param(...)` is interpolated from a key.
    expect(part).not.toMatch(/\$\{value\}|\$\{key\}|\$\{key\[/);
  });

  it("the notes of the file say how many rows were chosen and never their keys", () => {
    const service = stripComments(read("apps/web/lib/server/connection-service.ts"));
    expect(service).toMatch(/request\.keys\.length\} chosen/);
    expect(service).not.toMatch(/JSON\.stringify\(request\.keys|request\.keys\.map\(/);
  });

  it("the choice of rows to export is kept in memory only: no store, no storage", () => {
    const hook = read("apps/web/features/data/use-export-selection.ts");
    expect(hook).not.toMatch(/localStorage|sessionStorage|indexedDB|zustand|persist/);
    const places = [
      ...walk(path.join(root, "apps/web/stores")),
      ...walk(path.join(root, "apps/web/features/workspaces")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const file of places) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /use-export-selection|useExportSelection/,
      );
    }
  });
});

describe("the MCP server is a read-only door with a token of its own (decision 169)", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const mcpFiles = [
    ...walk(path.join(root, "packages/mcp/src")),
    "apps/web/lib/server/mcp-service.ts",
    "apps/web/app/mcp/route.ts",
    "apps/web/app/api/connections/[id]/claude/route.ts",
    "packages/cli/src/mcp-bridge.ts",
    "packages/cli/src/mcp-file.ts",
  ]
    .map((f) => (path.isAbsolute(f) ? f : path.join(root, f)))
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("/dist/"));

  it("no file of the MCP path writes to a log or the console", () => {
    for (const file of mcpFiles) {
      expect(stripComments(readFileSync(file, "utf8")), rel(file)).not.toMatch(/\bconsole\./);
    }
  });

  it("the service imports nothing that writes: no write service, no adapter write capability, no change", () => {
    const code = stripComments(read("apps/web/lib/server/mcp-service.ts"));
    expect(code).not.toMatch(
      /write-service|WriteService|WritableAdapter|isWritableAdapter|PlannedChange|previewChange|applyChange|exportRows/,
    );
    for (const file of mcpFiles) {
      expect(stripComments(readFileSync(file, "utf8")), rel(file)).not.toMatch(
        /write-service|WritableAdapter|isWritableAdapter|previewChange|applyChange|\.writes\b/,
      );
    }
  });

  it("the tools are exactly the pinned list, every one read-only, and none is named for a write", () => {
    const code = stripComments(read("apps/web/lib/server/mcp-service.ts"));
    const tools = code.slice(code.indexOf("const TOOLS"));
    const names = [...tools.matchAll(/^\s+name: "([a-z_]+)",$/gm)].map((m) => m[1]);
    // A new tool is a deliberate change of this list: a decision, a review and a test of its own.
    expect(names).toEqual([
      "list_connections",
      "list_schemas",
      "list_tables",
      "describe_table",
      "search_objects",
      "read_rows",
      "run_readonly_query",
      "explain_query",
    ]);
    expect((code.match(/annotations: READ_ONLY/g) ?? []).length).toBe(names.length);
    for (const name of names)
      expect(name).not.toMatch(/write|insert|update|delete|drop|create|alter|import|exec|run_sql/);
  });

  it("/mcp has its own guard, in the front door and in the route, and never the cookie's", () => {
    const proxy = stripComments(read("apps/web/proxy.ts"));
    expect(proxy).toMatch(/pathname === "\/mcp"/);
    expect(proxy).toContain("evaluateMcpRequest(mcpFactsFromRequest(request), security)");
    const route = stripComments(read("apps/web/app/mcp/route.ts"));
    expect(route).toContain(
      "evaluateMcpRequest(mcpFactsFromRequest(request), readSecurityConfig())",
    );
    expect(route).not.toMatch(/cookie|sessionCookieName|guardRequest|handleRoute/i);
    // The cookie guard never reads an Authorization header, so the token of /mcp is no credential for the app.
    const guard = stripComments(read("apps/web/lib/security/request-guard.ts"));
    const cookieGuard = guard.slice(
      guard.indexOf("export function evaluateRequest"),
      guard.indexOf("export interface McpRequestFacts"),
    );
    expect(cookieGuard).not.toMatch(/authorization|bearer|mcpToken/i);
  });

  it("the guard refuses a browser (Origin, Sec-Fetch-Site), compares the token in constant time, and the route answers 404 before anything is shared", () => {
    const guard = stripComments(read("apps/web/lib/security/request-guard.ts"));
    expect(guard).toMatch(/facts\.origin !== null \|\| facts\.secFetchSite !== null/);
    expect(guard).toMatch(/tokensMatch\(config\.mcpToken, readBearer\(facts\.authorization\)\)/);
    expect(stripComments(read("apps/web/app/mcp/route.ts"))).toMatch(/if \(!mcp\.anyShared\(\)\)/);
  });

  it("what is shared is kept in memory only: no file, no profile, no storage", () => {
    const service = stripComments(read("apps/web/lib/server/mcp-service.ts"));
    expect(service).not.toMatch(
      /writeFile|fs\/|storage|profile|localStorage|sessionStorage|setDataAccess/,
    );
    expect(stripComments(read("packages/shared-types/src/postgres-connection.ts"))).not.toMatch(
      /claude|mcp/i,
    );
  });

  it("the browser keeps the level of a sharing in memory only: no storage, no persistence, no token, no profile", () => {
    for (const file of [
      "apps/web/stores/claude-store.ts",
      "apps/web/features/claude/api.ts",
      "apps/web/features/claude/setup-text.ts",
    ]) {
      expect(read(file), file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|persist|document\.cookie|Bearer|mcpToken/,
      );
    }
    for (const file of walk(path.join(root, "apps/web/features/workspaces")).filter((f) =>
      /\.(ts|tsx)$/.test(f),
    )) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(
        /claude-store|useClaude|claudeSharing/,
      );
    }
  });

  it("mcp.json holds the token of /mcp and nothing of the browser's session, and is written 0600", () => {
    const file = stripComments(read("packages/cli/src/mcp-file.ts"));
    expect(file).toContain("0o600");
    const cli = stripComments(read("packages/cli/src/index.ts"));
    expect(cli).toMatch(/writeMcpFile\(dataDir, \{ pid: process\.pid, port, token: mcpToken \}\)/);
    expect(cli).toContain("const mcpToken = generateSessionToken()");
  });

  it("the bridge writes nothing but protocol to stdout", () => {
    const bridge = stripComments(read("packages/cli/src/mcp-bridge.ts"));
    expect(bridge).not.toMatch(/console\.|process\.stdout\.write/);
    expect(bridge).toContain("output.write(`${answer}\\n`)");
  });
});

describe("the MCP data tools reach the data only through the services that guard it (decision 169)", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const service = stripComments(read("apps/web/lib/server/mcp-service.ts"));

  it("holds no adapter for a statement or a page: statements go through SqlService, pages through ConnectionService", () => {
    expect(service).toMatch(/this\.sql\.run\(/);
    expect(service).toMatch(/this\.rows\.getRows\(/);
    expect(service).not.toMatch(
      /isSqlRunnerAdapter|adapter\.runStatement|adapter\.getRows|adapter\.exportRows|adapter\.getCell/,
    );
  });

  it("never reveals a hidden column: the page request carries no reveal, and no tool has a field for it", () => {
    expect(service).toMatch(/revealColumns: \[\]/);
    expect(service).not.toMatch(/reveal[A-Za-z]*: (?!\[\])/);
    const tools = service.slice(service.indexOf("const TOOLS"));
    expect(tools).not.toMatch(/reveal/i);
  });

  it("every data tool checks the level first, and a statement is checked for sensitive names before it is sent", () => {
    expect((service.match(/this\.requireData\(connection\)/g) ?? []).length).toBe(2);
    const run = service.slice(
      service.indexOf("async runQuery("),
      service.indexOf("async readRows("),
    );
    expect(run.indexOf("requireData")).toBeLessThan(run.indexOf("sensitiveNamesIn"));
    expect(run.indexOf("sensitiveNamesIn")).toBeLessThan(run.indexOf("this.sql.run("));
  });

  it("a database failure is passed on only through failureWords, never as the message of the error", () => {
    expect(service).toMatch(/failureWords\(outcome\.failure\)/);
    expect(service).not.toMatch(/error\.message|\.message\)/);
    const data = stripComments(read("apps/web/lib/server/mcp-data.ts"));
    expect(data).toMatch(/startsWith\("42"\)/);
  });
});
