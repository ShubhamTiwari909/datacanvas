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
    expect(callers.map(rel).sort()).toEqual([rel(rowsRoute), rel(service)].sort());
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
    // The definition of a constraint (an expression) is never read here.
    expect(code).not.toMatch(/\.definition\b/);
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
    expect(schema).toMatch(/format: z\.enum\(\["csv", "tsv", "json", "ndjson"\]\)/);
    const body = schema.slice(
      schema.indexOf("exportRequestSchema"),
      schema.indexOf("ParsedExportRequest"),
    );
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
    expect(code).toMatch(/FETCH \$\{EXPORT_BATCH_ROWS\} FROM dc_export/);
    expect(code).toContain("limit: EXPORT_MAX_ROWS + 1");
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
      /filters: request\.filters\.map\(\(f\) => `\$\{f\.column\} \$\{f\.op\.replace/,
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
    const run = source.indexOf("applyChange(plan)");
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
