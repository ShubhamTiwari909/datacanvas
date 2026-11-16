/**
 * Editing rows and designing tables, end to end (docs/data-editing-plan.md):
 * nothing is offered when DataCanvas starts read-only; the unlock needs the
 * database name; a row is edited, added and deleted through a preview; a row
 * changed meanwhile is refused; a table is created and altered; a drop with
 * dependents is refused; and no value ends up in the history.
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

const SECRET = "SECRET-VALUE-4711";

function client(database: TestDb): pg.Client {
  return new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
}

async function sql<Row extends Record<string, unknown> = Record<string, unknown>>(
  database: TestDb,
  text: string,
): Promise<Row[]> {
  const c = client(database);
  await c.connect();
  try {
    return (await c.query(text)).rows as Row[];
  } finally {
    await c.end();
  }
}

async function plant(database: TestDb): Promise<void> {
  await sql(
    database,
    `CREATE TABLE public.w_people (id integer PRIMARY KEY, name text NOT NULL, note text);
     INSERT INTO public.w_people VALUES (1, 'Ann', 'first'), (2, 'Bo', NULL), (3, 'Cy', '');
     CREATE TABLE public.w_orders (id integer PRIMARY KEY, person_id integer REFERENCES public.w_people(id));
     CREATE TABLE public.w_nokey (v text);
     INSERT INTO public.w_nokey VALUES ('x');`,
  );
}

async function connect(
  page: Page,
  link: string,
  database: TestDb,
  options: { dataAccess?: boolean } = {},
): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("W shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  if (options.dataAccess ?? true) await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect W shop" })).toBeVisible();
}

async function unlock(page: Page, database: TestDb): Promise<void> {
  await page.getByRole("switch", { name: "Allow changes to W shop" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Changes are committed immediately and cannot be undone."),
  ).toBeVisible();
  await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
  await dialog.getByRole("button", { name: "Allow changes" }).click();
  await expect(page.getByText("Writes on")).toBeVisible();
}

async function openTable(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("tab", { name: "Table details" }).click();
  await page.getByRole("button", { name }).first().click();
}

const grid = (page: Page) => page.getByRole("grid");

test("started read-only: nothing to unlock, and the Data section says how to start with writes", async ({
  page,
  app,
  database,
}) => {
  await plant(database);
  await connect(page, app.link, database);
  await expect(page.getByRole("switch", { name: /Allow changes to/ })).toHaveCount(0);
  await openTable(page, /^w_people\b/);
  await expect(grid(page)).toBeVisible();
  await expect(page.getByText(/started read-only/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add row" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit row 1" })).toHaveCount(0);
});

test("unlocking needs the database name, shows the role warning, and can be locked again", async ({
  page,
  writableApp,
  database,
}) => {
  expect(writableApp.output()).toContain("Writes are enabled");
  await plant(database);
  await connect(page, writableApp.link, database);

  await page.getByRole("switch", { name: "Allow changes to W shop" }).click();
  const dialog = page.getByRole("dialog");
  // The test database's role is a superuser, which the dialog warns about.
  await expect(dialog.getByRole("list", { name: "Role warnings" })).toContainText(/superuser/i);
  await dialog.getByRole("textbox", { name: "Database name" }).fill("not-the-name");
  await dialog.getByRole("button", { name: "Allow changes" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Writes on")).toHaveCount(0);

  await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
  await dialog.getByRole("button", { name: "Allow changes" }).click();
  await expect(page.getByText("Writes on")).toBeVisible();

  await page.getByRole("button", { name: "Lock writes for W shop" }).click();
  await expect(page.getByText("Writes on")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Allow changes to W shop" })).toBeVisible();
});

test("writing needs table data to be on", async ({ page, writableApp, database }) => {
  await plant(database);
  await connect(page, writableApp.link, database, { dataAccess: false });
  await expect(page.getByRole("switch", { name: "Allow changes to W shop" })).toBeDisabled();
  await expect(page.getByText(/needs .?Table data.? switched on/)).toBeVisible();
});

test.describe("with writes unlocked", () => {
  test.beforeEach(async ({ page, writableApp, database }) => {
    await plant(database);
    await connect(page, writableApp.link, database);
    await unlock(page, database);
  });

  test("edit a row through a preview, and NULL stays different from empty", async ({
    page,
    database,
  }) => {
    await openTable(page, /^w_people\b/);
    await expect(grid(page)).toBeVisible();
    await page.getByRole("button", { name: "Edit row 1" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "name", exact: true }).fill(`Anna ${SECRET}`);
    await dialog.getByLabel("NULL for note").check();
    await dialog.getByRole("button", { name: "Preview" }).click();

    // The statement is shown with $n for values, and the values before and after in a table.
    const preview = page.getByRole("dialog");
    const statement = preview.getByLabel("The statement that will run");
    await expect(statement).toContainText('UPDATE "public"."w_people"');
    await expect(statement).not.toContainText(SECRET);
    await expect(preview.getByRole("table")).toContainText(`Anna ${SECRET}`);
    await preview.getByRole("button", { name: "Apply" }).click();

    await expect(page.getByText("The row was changed.")).toBeVisible();
    const rows = await sql<{ name: string; note: string | null }>(
      database,
      "SELECT name, note FROM public.w_people WHERE id = 1",
    );
    expect(rows).toEqual([{ name: `Anna ${SECRET}`, note: null }]);

    // The session history names the change and the columns, never a value.
    await page.getByRole("button", { name: "Changes made to W shop in this session" }).click();
    const history = page.getByRole("list", { name: "Changes" });
    await expect(history).toContainText("w_people");
    await expect(history).not.toContainText(SECRET);
    await expect(history).not.toContainText("Anna");
  });

  test("a row changed meanwhile is refused and nothing is written", async ({ page, database }) => {
    await openTable(page, /^w_people\b/);
    await expect(grid(page)).toBeVisible();
    await page.getByRole("button", { name: "Edit row 2" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "name", exact: true }).fill("Bob");
    await dialog.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("button", { name: "Apply" })).toBeEnabled();

    // Someone else changes the same column in the meantime.
    await sql(database, "UPDATE public.w_people SET name = 'Beau' WHERE id = 2");
    await preview.getByRole("button", { name: "Apply" }).click();

    await expect(preview.getByRole("alert")).toContainText(/changed or deleted since you loaded/);
    await expect(preview.getByRole("button", { name: "Reload the rows" })).toBeVisible();
    expect(await sql(database, "SELECT name FROM public.w_people WHERE id = 2")).toEqual([
      { name: "Beau" },
    ]);
  });

  test("add a row with a default and a NULL, then delete it", async ({ page, database }) => {
    await openTable(page, /^w_people\b/);
    await expect(grid(page)).toBeVisible();
    await page.getByRole("button", { name: "Add row" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Value for id" }).check();
    await dialog.getByRole("textbox", { name: "Value for id" }).fill("10");
    await dialog.getByRole("radio", { name: "Value for name" }).check();
    await dialog.getByRole("textbox", { name: "Value for name" }).fill("Dee");
    await dialog.getByRole("radio", { name: "NULL for note" }).check();
    await dialog.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("The row was added.")).toBeVisible();
    expect(await sql(database, "SELECT name, note FROM public.w_people WHERE id = 10")).toEqual([
      { name: "Dee", note: null },
    ]);

    // Delete it: needs the tick, and names what points at the table.
    await page.getByRole("button", { name: "Delete row 4" }).click();
    const preview = page.getByRole("dialog");
    const apply = preview.getByRole("button", { name: "Apply" });
    await expect(apply).toBeDisabled();
    await expect(preview.getByLabel("The statement that will run")).toContainText("DELETE FROM");
    await preview.getByRole("checkbox", { name: /I have read this/ }).check();
    await apply.click();
    await expect(page.getByText("The row was deleted.")).toBeVisible();
    expect(await sql(database, "SELECT id FROM public.w_people WHERE id = 10")).toEqual([]);
  });

  test("a violation is a fixed sentence and never repeats the value", async ({
    page,
    database,
  }) => {
    await openTable(page, /^w_people\b/);
    await expect(grid(page)).toBeVisible();
    await page.getByRole("button", { name: "Add row" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Value for id" }).check();
    await dialog.getByRole("textbox", { name: "Value for id" }).fill("1"); // already taken
    await dialog.getByRole("radio", { name: "Value for name" }).check();
    await dialog.getByRole("textbox", { name: "Value for name" }).fill(SECRET);
    await dialog.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog");
    await preview.getByRole("button", { name: "Apply" }).click();

    const alert = preview.getByRole("alert");
    await expect(alert).toContainText("A row with the same value already exists");
    await expect(page.locator("body")).not.toContainText(SECRET);
    expect(await sql(database, `SELECT 1 FROM public.w_people WHERE name = '${SECRET}'`)).toEqual(
      [],
    );
  });

  test("a table without a key cannot be edited, and says why", async ({ page }) => {
    await openTable(page, /^w_nokey\b/);
    await expect(grid(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit row 1" })).toHaveCount(0);
    await expect(page.getByText(/primary key|unique index/i).first()).toBeVisible();
  });

  test("create a table, alter it, and a drop with dependents is refused", async ({
    page,
    database,
  }) => {
    await page.getByRole("button", { name: "New table in public" }).click();
    const create = page.getByRole("dialog");
    await create.getByRole("textbox", { name: "Table name" }).fill("w_made");
    await create.getByLabel("Column 1 name").fill("id");
    await create.getByLabel("Column 1 type").selectOption("integer");
    await create.getByRole("button", { name: "Add a column" }).click();
    await create.getByLabel("Column 2 name").fill("label");
    await create.getByLabel("Column 2 type").selectOption("text");
    await create.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog");
    await expect(preview.getByLabel("The statement that will run")).toContainText(
      'CREATE TABLE "public"."w_made"',
    );
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("button", { name: /^w_made\b/ }).first()).toBeVisible();
    expect(
      await sql(
        database,
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'w_made' ORDER BY ordinal_position",
      ),
    ).toEqual([{ column_name: "id" }, { column_name: "label" }]);

    // Dropping a table that a foreign key points at is refused: no CASCADE.
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^w_people\b/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Edit structure" }).click();
    const alter = page.getByRole("dialog");
    await alter.getByLabel("What to change").selectOption({ label: "Drop the table" });
    await alter.getByRole("textbox", { name: /Type .*w_people.* to confirm/ }).fill("w_people");
    await alter.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(/depend/i);
    expect(await sql(database, "SELECT to_regclass('public.w_people') IS NOT NULL AS ok")).toEqual([
      { ok: true },
    ]);
  });
});
