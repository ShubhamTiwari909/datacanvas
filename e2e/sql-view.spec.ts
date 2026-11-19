/**
 * The SQL view, end to end (1.6.0, S2; docs/sql-workspace-plan.md): the SQL tab with one
 * editor, Run and Cancel, a results grid, the database's errors with a marker in the text,
 * a refused write, the row cap, and the viewing switch.
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

async function admin<Row extends Record<string, unknown> = Record<string, unknown>>(
  database: TestDb,
  text: string,
): Promise<Row[]> {
  const c = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await c.connect();
  try {
    return (await c.query(text)).rows as Row[];
  } finally {
    await c.end();
  }
}

async function open(page: Page, link: string, database: TestDb, dataAccess = true) {
  await admin(
    database,
    `CREATE TABLE public.s_items (id int PRIMARY KEY, v text);
     INSERT INTO public.s_items VALUES (1, 'one'), (2, NULL), (3, '');`,
  );
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sql shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  if (dataAccess) await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Sql shop" })).toBeVisible();
  await page.getByRole("tab", { name: "SQL" }).click();
}

const editor = (page: Page) => page.getByRole("textbox", { name: /SQL editor/ });

/** Monaco's own input is a 1 px textarea that sits under its text: click the editor, not the input. */
const focusEditor = (page: Page) => page.locator(".monaco-editor .view-lines").first().click();

/** Replace the editor's text (insertText sends no key events, so Monaco's auto-closing stays out of it). */
async function typeSql(page: Page, text: string) {
  await focusEditor(page);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

/** The result area: the page also has other alerts (the role warning, the route announcer). */
const resultPanel = (page: Page) => page.getByRole("region", { name: "Result" });

const run = (page: Page) => page.getByRole("button", { name: "Run", exact: true });

test("runs a statement and shows the rows, NULL and the empty string apart", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await expect(editor(page)).toBeVisible();
  await typeSql(page, "SELECT id, v FROM public.s_items ORDER BY id");
  await run(page).click();

  const grid = page.getByRole("grid", { name: "Query result" });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("columnheader")).toHaveText(["#", "id", "v"]);
  const rows = grid.getByRole("row");
  await expect(rows).toHaveCount(4); // header + 3
  await expect(rows.nth(1)).toContainText("one");
  await expect(rows.nth(2)).toContainText("NULL");
  await expect(rows.nth(3)).toContainText("(empty)");
  await expect(page.getByText(/^3 rows\b/)).toBeVisible();
  await expect(page.getByText(/\d+ ms/)).toBeVisible();
});

test("Ctrl or Cmd plus Enter runs, and a selection runs alone", async ({ page, app, database }) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT 1 AS first;\nSELECT 2 AS second");
  await page.keyboard.press("ControlOrMeta+Enter");
  // The whole text is two statements: the database refuses it, and says so.
  await expect(resultPanel(page).getByRole("alert")).toContainText(
    /multiple commands|more than one/i,
  );

  // Select the second line only and run that.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("ControlOrMeta+Enter");
  const grid = page.getByRole("grid", { name: "Query result" });
  await expect(grid.getByRole("columnheader", { name: "second" })).toBeVisible();
  await expect(grid.getByRole("row").nth(1)).toContainText("2");
});

test("shows the database's error and marks the place in the text", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT * FROM public.nope");
  await run(page).click();
  const alert = resultPanel(page).getByRole("alert");
  await expect(alert).toContainText('relation "public.nope" does not exist');
  await expect(alert).toContainText("42P01");
  await expect(page.locator(".monaco-editor .squiggly-error").first()).toBeVisible();
  // Typing again clears the marker.
  await focusEditor(page);
  await page.keyboard.insertText(" ");
  await expect(page.locator(".monaco-editor .squiggly-error")).toHaveCount(0);
});

test("refuses to write: by its first word, and in the database for what gets past it", async ({
  page,
  app,
  database,
}) => {
  await admin(
    database,
    `CREATE TABLE public.s_items (id int PRIMARY KEY, v text); INSERT INTO public.s_items VALUES (1, 'one');
     CREATE FUNCTION public.s_writer() RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM public.s_items; RETURN 1; END $$`,
  );
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sql shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Sql shop" })).toBeVisible();
  await page.getByRole("tab", { name: "SQL" }).click();

  await typeSql(page, "DELETE FROM public.s_items");
  await run(page).click();
  await expect(resultPanel(page).getByRole("alert")).toContainText("read-only");

  await typeSql(page, "SELECT public.s_writer()");
  await run(page).click();
  await expect(resultPanel(page).getByRole("alert")).toContainText(/read-only transaction/);
  expect(await admin(database, "SELECT count(*)::int AS n FROM public.s_items")).toEqual([
    { n: 1 },
  ]);
});

test("Cancel stops a running statement in the database", async ({ page, app, database }) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT pg_sleep(30)");
  await run(page).click();
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeVisible();
  await expect(run(page)).toBeDisabled();
  const backends = async () =>
    (
      await admin<{ n: number }>(
        database,
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'DataCanvas SQL'",
      )
    )[0]!.n;
  await expect.poll(backends, { timeout: 5000 }).toBe(1);
  await cancel.click();
  await expect(resultPanel(page).getByRole("status")).toContainText(/cancelled/i);
  await expect(run(page)).toBeEnabled();
  await expect.poll(backends, { timeout: 10_000 }).toBe(0);
});

test("stops at the row cap and says so", async ({ page, app, database }) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT g FROM generate_series(1, 5000) g");
  await run(page).click();
  await expect(page.getByText(/first 1,000 rows/)).toBeVisible();
  await expect(page.getByRole("grid", { name: "Query result" }).getByRole("row")).toHaveCount(1001);
});

test("needs table data to be on, and offers to switch it on", async ({ page, app, database }) => {
  await open(page, app.link, database, false);
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByText(/needs viewing table data/i)).toBeVisible();
  await page.getByRole("button", { name: /Switch on table data/i }).click();
  await expect(editor(page)).toBeVisible();
});

// ------------------------------------------------------------------ tabs (S3) ---

const queryTabs = (page: Page) => page.getByRole("tablist", { name: "Query tabs" });
const queryTab = (page: Page, name: string | RegExp) => queryTabs(page).getByRole("tab", { name });

test("opens several query tabs, each keeping its text and its result", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await expect(queryTab(page, "Query 1")).toHaveAttribute("aria-selected", "true");
  await typeSql(page, "SELECT 1 AS first_tab");
  await run(page).click();
  await expect(page.getByRole("grid", { name: "Query result" })).toContainText("1");

  await page.getByRole("button", { name: "New query tab" }).click();
  await expect(queryTab(page, "Query 2")).toHaveAttribute("aria-selected", "true");
  // A new tab is empty and has no result.
  await expect(page.getByRole("grid", { name: "Query result" })).toHaveCount(0);
  await typeSql(page, "SELECT 2 AS second_tab");
  await run(page).click();
  await expect(
    page
      .getByRole("grid", { name: "Query result" })
      .getByRole("columnheader", { name: "second_tab" }),
  ).toBeVisible();

  await queryTab(page, "Query 1").click();
  await expect(
    page
      .getByRole("grid", { name: "Query result" })
      .getByRole("columnheader", { name: "first_tab" }),
  ).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 1 AS first_tab");
  await queryTab(page, "Query 2").click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 2 AS second_tab");
});

test("renames, duplicates and closes a tab, and the last one is replaced by an empty one", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT 'keep me' AS v");
  await page.getByRole("button", { name: "Rename query tab" }).click();
  const name = page.getByRole("textbox", { name: "Tab name" });
  await name.fill("Orders check");
  await name.press("Enter");
  await expect(queryTab(page, "Orders check")).toBeVisible();

  await page.getByRole("button", { name: "Duplicate query tab" }).click();
  await expect(queryTab(page, "Orders check (copy)")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 'keep me' AS v");

  await page.getByRole("button", { name: "Close Orders check (copy)" }).click();
  await expect(queryTab(page, "Orders check (copy)")).toHaveCount(0);
  await expect(queryTab(page, "Orders check")).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Close Orders check" }).click();
  await expect(queryTabs(page).getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".monaco-editor .view-lines")).not.toContainText("keep me");
});

test("one statement runs at a time: another tab waits, and closing the running tab cancels it", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT pg_sleep(30)");
  await run(page).click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New query tab" }).click();
  await typeSql(page, "SELECT 1");
  await expect(run(page)).toBeDisabled();
  await expect(page.getByText(/Query 1 is running/)).toBeVisible();

  const backends = async () =>
    (
      await admin<{ n: number }>(
        database,
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'DataCanvas SQL'",
      )
    )[0]!.n;
  await expect.poll(backends, { timeout: 5000 }).toBe(1);
  await page.getByRole("button", { name: "Close Query 1" }).click();
  await expect.poll(backends, { timeout: 10_000 }).toBe(0);
  await expect(run(page)).toBeEnabled();
});

test("saves a tab as a .sql file and opens a .sql file in a new tab", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT 'saved' AS v");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save query as .sql" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Query 1.sql");
  const saved = (await import("node:fs")).readFileSync((await download.path())!, "utf8");
  expect(saved).toBe("SELECT 'saved' AS v");

  await page.getByLabel("Open a .sql file").setInputFiles({
    name: "from-disk.sql",
    mimeType: "application/sql",
    buffer: Buffer.from("SELECT 'from disk' AS v"),
  });
  await expect(queryTab(page, "from-disk")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 'from disk' AS v");
});

test("each tab keeps its own undo history, and arrow keys move between tabs", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT 1");
  await page.getByRole("button", { name: "New query tab" }).click();
  await typeSql(page, "SELECT 2");

  await queryTab(page, "Query 1").click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 1");
  // Undo in the first tab goes back through ITS typing: the second tab's text never appears.
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(page.locator(".monaco-editor .view-lines")).not.toContainText("SELECT 2");
  await expect(page.locator(".monaco-editor .view-lines")).not.toContainText("SELECT 1");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 1");

  // Arrow keys on a tab move to the next one.
  await queryTab(page, "Query 1").focus();
  await page.keyboard.press("ArrowRight");
  await expect(queryTab(page, "Query 2")).toHaveAttribute("aria-selected", "true");
  await expect(queryTab(page, "Query 2")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(queryTab(page, "Query 1")).toBeFocused();
});

// ------------------------------------------------------------ completion (S4) ---

const suggestions = (page: Page) => page.locator(".suggest-widget.visible .monaco-list-row");

test("suggests tables of the database after FROM, and inserts the one chosen", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT * FROM us");
  await page.keyboard.press("ControlOrMeta+Space");
  await expect(suggestions(page).filter({ hasText: "users" }).first()).toBeVisible();
  // The columns of a table do not appear where a table is wanted.
  await expect(suggestions(page).filter({ hasText: "email" })).toHaveCount(0);
  // user_profiles sorts first; pick the one wanted.
  await suggestions(page).filter({ hasText: "userspublic · table" }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT * FROM users");
  await expect(page.locator(".monaco-editor .view-lines")).not.toContainText("user_profiles");
});

test("suggests the columns of an alias after a dot, with their types", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT  FROM public.users u");
  await page.keyboard.press("Home"); // one line: its start is the start of the text
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
  // Typing the dot opens the list by itself.
  await page.keyboard.type("u.");
  const email = suggestions(page).filter({ hasText: "email" }).first();
  await expect(email).toBeVisible();
  // The type is shown beside the column, with the alias it belongs to.
  await expect(email).toContainText("u · text");
  await page.keyboard.type("em");
  await page.keyboard.press("Enter");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "SELECT u.email FROM public.users u",
  );
  // The text still runs.
  await run(page).click();
  await expect(
    resultPanel(page)
      .getByRole("grid", { name: "Query result" })
      .getByRole("columnheader", { name: "email" }),
  ).toBeVisible();
});

test("suggests names of the database after the schema and a dot, and nothing inside a string", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT * FROM public.");
  await page.keyboard.press("ControlOrMeta+Space");
  await expect(suggestions(page).filter({ hasText: "s_items" }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await typeSql(page, "SELECT 'us");
  await page.keyboard.press("ControlOrMeta+Space");
  await expect(page.locator(".suggest-widget.visible")).toHaveCount(0);
});

// -------------------------------------------------- history, export, explain (S5) ---

const historyDialog = (page: Page) => page.getByRole("dialog", { name: "Query history" });
const statements = (page: Page) => historyDialog(page).getByRole("list", { name: "Statements" });

test("keeps a history of what ran, searchable, to open or run again", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT 1 AS first_one");
  await run(page).click();
  await expect(resultPanel(page).getByRole("grid")).toBeVisible();
  await typeSql(page, "SELECT * FROM public.nope");
  await run(page).click();
  await expect(resultPanel(page).getByRole("alert")).toBeVisible();
  await typeSql(page, "SELECT 2 AS second_one");
  await run(page).click();
  await expect(
    resultPanel(page).getByRole("grid").getByRole("columnheader", { name: "second_one" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Query history" }).click();
  const items = statements(page).getByRole("listitem");
  await expect(items).toHaveCount(3);
  // Newest first, with how each went.
  await expect(items.nth(0)).toContainText("SELECT 2 AS second_one");
  await expect(items.nth(0)).toContainText("1 row");
  await expect(items.nth(1)).toContainText("SELECT * FROM public.nope");
  await expect(items.nth(1)).toContainText("42P01");
  await expect(items.nth(2)).toContainText("SELECT 1 AS first_one");

  await historyDialog(page).getByRole("searchbox", { name: "Search the history" }).fill("first");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("first_one");

  // Open it in a new tab: the text is there and nothing was run.
  await items.first().getByRole("button", { name: "Open in a new tab" }).click();
  await expect(historyDialog(page)).toHaveCount(0);
  await expect(queryTabs(page).getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("SELECT 1 AS first_one");
  await expect(resultPanel(page).getByRole("grid")).toHaveCount(0);

  // Run again: another tab, and a result.
  await page.getByRole("button", { name: "Query history" }).click();
  await statements(page)
    .getByRole("listitem")
    .filter({ hasText: "second_one" })
    .getByRole("button", { name: "Run again" })
    .click();
  await expect(queryTabs(page).getByRole("tab")).toHaveCount(3);
  await expect(
    resultPanel(page).getByRole("grid").getByRole("columnheader", { name: "second_one" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Query history" }).click();
  await expect(statements(page).getByRole("listitem")).toHaveCount(4);
  await historyDialog(page).getByRole("button", { name: "Clear history" }).click();
  await expect(historyDialog(page).getByText("Nothing was run yet.")).toBeVisible();
});

test("copies the rows as TSV, CSV and JSON, and saves a CSV file", async ({
  page,
  app,
  database,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, app.link, database);
  await typeSql(page, "SELECT id, v, '=1+1' AS f FROM public.s_items ORDER BY id");
  await run(page).click();
  await expect(resultPanel(page).getByRole("grid")).toBeVisible();
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  await resultPanel(page).getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Copy as TSV" }).click();
  expect(await clipboard()).toBe("id\tv\tf\r\n1\tone\t'=1+1\r\n2\t\t'=1+1\r\n3\t\t'=1+1");

  await resultPanel(page)
    .getByRole("button", { name: /Export|Copied/ })
    .click();
  await page.getByRole("menuitem", { name: "Copy as CSV" }).click();
  expect(await clipboard()).toBe("id,v,f\r\n1,one,'=1+1\r\n2,,'=1+1\r\n3,,'=1+1");

  await resultPanel(page)
    .getByRole("button", { name: /Export|Copied/ })
    .click();
  await page.getByRole("menuitem", { name: "Copy as JSON" }).click();
  expect(JSON.parse(await clipboard())).toEqual([
    { id: "1", v: "one", f: "=1+1" },
    { id: "2", v: null, f: "=1+1" },
    { id: "3", v: "", f: "=1+1" },
  ]);

  await resultPanel(page)
    .getByRole("button", { name: /Export|Copied/ })
    .click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Query 1.csv");
  const file = (await import("node:fs")).readFileSync((await download.path())!, "utf8");
  expect(file).toBe("﻿id,v,f\r\n1,one,'=1+1\r\n2,,'=1+1\r\n3,,'=1+1");
});

test("shows the plan of a statement, with or without running it", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT * FROM public.s_items WHERE id = 2");
  await page.getByRole("button", { name: "Explain" }).click();
  await page.getByRole("menuitem", { name: /^Explain Shows the plan/ }).click();
  const plan = resultPanel(page).getByLabel("Query plan");
  await expect(plan).toContainText(/Scan.*s_items/);
  await expect(plan).not.toContainText("Execution Time");

  await page.getByRole("button", { name: "Explain" }).click();
  await page.getByRole("menuitem", { name: /^Explain analyze/ }).click();
  await expect(resultPanel(page).getByLabel("Query plan")).toContainText("Execution Time");

  // The plan can be copied as text.
  await resultPanel(page)
    .getByRole("button", { name: /Export/ })
    .click();
  await expect(page.getByRole("menuitem", { name: "Copy the plan" })).toBeVisible();
});

test("explains a statement that is already an EXPLAIN as it is, and marks an error in the right place", async ({
  page,
  app,
  database,
}) => {
  await open(page, app.link, database);
  await typeSql(page, "EXPLAIN SELECT 1");
  await page.getByRole("button", { name: "Explain" }).click();
  await page.getByRole("menuitem", { name: /^Explain Shows the plan/ }).click();
  await expect(resultPanel(page).getByLabel("Query plan")).toContainText("Result");

  await typeSql(page, "SELECT * FROM public.nope");
  await page.getByRole("button", { name: "Explain" }).click();
  await page.getByRole("menuitem", { name: /^Explain Shows the plan/ }).click();
  const alert = resultPanel(page).getByRole("alert");
  await expect(alert).toContainText('relation "public.nope" does not exist');
  // The column counts from the person's text, not from the EXPLAIN in front of it.
  await expect(alert).toContainText("line 1, column 15");
  await expect(page.locator(".monaco-editor .squiggly-error").first()).toBeVisible();
});

test("Run and Explain use the selection when there is one", async ({ page, app, database }) => {
  await open(page, app.link, database);
  await typeSql(page, "SELECT 1 AS a;\nSELECT 2 AS b");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Shift+Home");
  await run(page).click();
  await expect(
    resultPanel(page).getByRole("grid").getByRole("columnheader", { name: "b" }),
  ).toBeVisible();
});
