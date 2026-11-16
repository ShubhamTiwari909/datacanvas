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

  it("the README and SECURITY.md say it is off by default and that rows are never saved", () => {
    for (const file of ["README.md", "SECURITY.md"]) {
      const content = text(file).replace(/\s+/g, " ").toLowerCase();
      expect(content, file).toContain("off by default");
      expect(content, file).toMatch(/never (written to a file|saved)/);
    }
  });
});
