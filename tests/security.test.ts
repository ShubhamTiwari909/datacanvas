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

describe("no arbitrary SQL, ever", () => {
  it("has no route whose path suggests running SQL", () => {
    for (const file of routeFiles) {
      expect(rel(file).toLowerCase(), rel(file)).not.toMatch(/\b(sql|query|exec|execute|raw)\b/);
    }
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

describe("a sort and conditions never become SQL text", () => {
  const stripComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");

  it("the request schema is strict all the way down: the request, the sort and every condition", () => {
    const code = read("packages/shared-types/src/connections.ts");
    expect(code).toMatch(/rowsRequestSchema = z\s*\.strictObject/);
    expect(code).toMatch(/rowSortSchema = z\s*\.strictObject/);
    expect(code).toMatch(/rowFilterSchema = z\s*\.strictObject/);
    // The operator is one of a fixed list, never free text.
    expect(code).toMatch(/op: z\.enum\(ROW_FILTER_OPERATORS\)/);
  });

  it("the service passes both to the adapter untouched: structured data, no text is built from them", () => {
    const code = stripComments(read("apps/web/lib/server/connection-service.ts"));
    const start = code.indexOf("getRows(id: string");
    const end = code.indexOf("unlinkProfile(", start);
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
    expect(code).toContain("Object.hasOwn(FILTER_SQL");
    // LIKE would make a % or _ in a value a wildcard; contains and starts with are strpos and starts_with.
    expect(code).not.toMatch(/\b(I?LIKE|SIMILAR TO)\b/i);
    expect(code).not.toMatch(/~\*?\s/); // no regular-expression operator either
    // Every value of a condition goes through the parameter function.
    expect(code).toMatch(/write\(column, param\(filter\.value\)\)/);
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

  it.each([
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
    "caches.",
    "persist(",
  ])("the data viewer never touches %s", (api) => {
    for (const file of dataFiles) expect(code(file), rel(file)).not.toContain(api);
  });

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
  it("finds the eight routes", () => {
    expect(writeRoutes.map(rel).sort()).toEqual(
      [
        "apps/web/app/api/connections/[id]/role/route.ts",
        "apps/web/app/api/connections/[id]/writes/apply/route.ts",
        "apps/web/app/api/connections/[id]/writes/edit-info/route.ts",
        "apps/web/app/api/connections/[id]/writes/history/route.ts",
        "apps/web/app/api/connections/[id]/writes/lock/route.ts",
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
    // The CLI drops a value inherited from the shell: only the flag can turn writes on.
    expect(codeOf("packages/cli/src/web-server.ts")).toMatch(/delete rest\[ENABLE_WRITES_ENV\]/);
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
