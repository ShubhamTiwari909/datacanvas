/**
 * Performance in the real UI: a schema with 1000 tables (the most one click adds) put on the canvas.
 * Budgets are generous (a loaded CI machine is slower than a laptop); they
 * catch a change in kind, such as rendering every node at once or a layout
 * that never finishes.
 */
import pg from "pg";
import { expect, test } from "./fixtures";

const TABLES = 1000;

test("1000 tables: load the canvas, auto-layout, stay responsive", async ({
  page,
  app,
  database,
}) => {
  test.setTimeout(180_000);

  // Build the big schema.
  const client = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await client.connect();
  const sql = ["CREATE SCHEMA big;"];
  for (let i = 0; i < TABLES; i += 1) {
    const parent = Math.max(0, i - 1 - (i % 5));
    const reference = i === 0 ? "" : `, parent_id integer REFERENCES big.t${parent}(id)`;
    sql.push(
      `CREATE TABLE big.t${i} (id integer PRIMARY KEY, name text, a int, b int, c int${reference});`,
    );
  }
  await client.query(sql.join("\n"));
  await client.end();

  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Big");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Big" })).toBeVisible();

  // Open the schema and add all of its tables.
  await page
    .getByRole("button", { name: /^big\b/ })
    .first()
    .click();
  const started = Date.now();
  await page.getByRole("button", { name: "Add all tables of big to the canvas" }).click();
  await expect(page.getByText(`${TABLES} tables`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const addMs = Date.now() - started;
  console.info(`[perf] add ${TABLES} tables to the canvas: ${addMs} ms`);
  expect(addMs).toBeLessThan(15_000);

  // Only the nodes in view are drawn: the page must not hold hundreds of DOM nodes.
  const drawn = await page.locator(".react-flow__node").count();
  console.info(`[perf] nodes drawn in the DOM: ${drawn} of ${TABLES}`);
  expect(drawn).toBeLessThan(TABLES);

  // Auto-layout the whole thing.
  const layoutStart = Date.now();
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("menuitem", { name: /Hierarchical/ }).click();
  await expect(page.getByRole("menuitem", { name: /Hierarchical/ })).toHaveCount(0);
  // Wait for the UI to settle: the toolbar must answer a click right after the layout.
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  const layoutMs = Date.now() - layoutStart;
  console.info(`[perf] hierarchical layout + menu response: ${layoutMs} ms`);
  expect(layoutMs).toBeLessThan(30_000);
});

test("sidebar table search: 5000 tables in 50 schemas, time to the first result", async ({
  page,
  app,
  database,
}) => {
  test.setTimeout(180_000);
  const SCHEMAS = 50;
  const PER_SCHEMA = 100;

  const client = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await client.connect();
  // One schema per statement batch: a single transaction of 5000 tables runs out of lock slots.
  for (let s = 0; s < SCHEMAS; s += 1) {
    const sql = [`CREATE SCHEMA s${s};`];
    for (let t = 0; t < PER_SCHEMA; t += 1) {
      sql.push(`CREATE TABLE s${s}.t${t} (id integer PRIMARY KEY, name text);`);
    }
    await client.query(sql.join("\n"));
  }
  await client.query("CREATE TABLE s49.needle_in_haystack (id integer PRIMARY KEY);");
  await client.end();

  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Many");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Many" })).toBeVisible();

  const search = page.getByRole("textbox", { name: "Find a table" });
  const started = Date.now();
  await search.fill("needle");
  await expect(page.getByRole("button", { name: /^needle_in_haystack\b/ })).toBeVisible();
  const firstResult = Date.now() - started;

  // Typing more filters in the browser only: no new request, and fast.
  const again = Date.now();
  await search.fill("needle_in");
  await expect(page.getByText(/^1 of 50\d\d tables and views$/)).toBeVisible();
  const narrowed = Date.now() - again;

  console.log(`sidebar search: first result ${firstResult} ms, then ${narrowed} ms`);
  expect(firstResult).toBeLessThan(10_000);
  expect(narrowed).toBeLessThan(2_000);
});
