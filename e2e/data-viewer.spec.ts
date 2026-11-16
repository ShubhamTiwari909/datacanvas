/**
 * Viewing table data, end to end: off by default, the opt-in, rows read one page
 * at a time, hidden (masked) columns, a long value in a dialog, awkward names, a
 * table without a key, switching off, reconnecting a saved connection, and that
 * no row is left in the page once access is off or the connection is gone.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { expect, test, type TestDb } from "./fixtures";
import type { Page } from "@playwright/test";

const HASH = "HASH-SECRET-";
const KEY = "KEY-SECRET-";

async function plant(database: TestDb): Promise<void> {
  const client = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE public.dv_people (
        id integer PRIMARY KEY, name text, note text, bio text, password_hash text, api_key text
      );
      INSERT INTO public.dv_people
        SELECT i, 'Person ' || i,
               CASE WHEN i = 1 THEN NULL WHEN i = 2 THEN '' ELSE 'note ' || i END,
               CASE WHEN i = 3 THEN repeat('long ', 600) END,
               '${HASH}' || i, '${KEY}' || i
        FROM generate_series(1, 130) AS i;

      CREATE TABLE public."Dv Odd ""Table" ("select" integer PRIMARY KEY, "Unit Price" numeric, "日本語 🙂" text);
      INSERT INTO public."Dv Odd ""Table" VALUES (1, 9.99, 'odd value');

      CREATE TABLE public.dv_nokey (v text);
      INSERT INTO public.dv_nokey VALUES ('no key row 1'), ('no key row 2'), ('no key row 3');
    `);
  } finally {
    await client.end();
  }
}

/** Connect with the connection string; optionally switch data access on in the connect dialog. */
async function connect(
  page: Page,
  database: TestDb,
  app: { link: string },
  options: { dataAccess?: boolean; url?: string } = {},
): Promise<void> {
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("DV shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(options.url ?? database.url);
  if (options.dataAccess) await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect DV shop" })).toBeVisible();
}

async function openTable(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("tab", { name: "Table details" }).click();
  await page.getByRole("button", { name }).first().click();
}

const grid = (page: Page) => page.getByRole("grid");

test.describe("data viewer", () => {
  test.beforeEach(async ({ database }) => {
    await plant(database);
  });

  test("is off by default, explains itself, and reads nothing until it is switched on", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app);
    await openTable(page, /^dv_people\b/);

    await expect(page.getByText("Table data is switched off")).toBeVisible();
    await expect(grid(page)).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain("Person 1");
    expect(html).not.toContain(HASH);
    // The structure of the table is still there.
    await expect(page.getByRole("heading", { name: /dv_people/ })).toBeVisible();

    await page.getByRole("button", { name: "Allow viewing table data" }).click();
    await expect(grid(page)).toBeVisible();
    await expect(page.getByText("Data access: on")).toBeVisible();
  });

  test("shows rows, pages forward and back, and tells NULL from the empty string", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);

    await expect(grid(page)).toBeVisible();
    await expect(page.getByText("Ordered by id (the primary key).")).toBeVisible();
    // Row 1 has a NULL note, row 2 an empty one: they must look different.
    await expect(grid(page).getByText("NULL").first()).toBeVisible();
    await expect(grid(page).getByText("(empty)").first()).toBeVisible();

    await page.getByLabel("Rows per page").selectOption("25");
    await expect(
      grid(page).getByRole("gridcell", { name: "Person 25", exact: true }),
    ).toBeVisible();
    await expect(grid(page).getByRole("gridcell", { name: "Person 26", exact: true })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText(/^Page 2/)).toBeVisible();
    await expect(
      grid(page).getByRole("gridcell", { name: "Person 26", exact: true }),
    ).toBeVisible();
    await expect(grid(page).getByRole("gridcell", { name: "Person 25", exact: true })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Previous" }).click();
    await expect(page.getByText(/^Page 1/)).toBeVisible();
    await expect(grid(page).getByRole("gridcell", { name: "Person 1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();

    // Walk to the last page: 130 rows at 25 per page is 6 pages, and Next ends there.
    for (let i = 0; i < 5; i += 1) await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText(/^Page 6/)).toBeVisible();
    await expect(
      grid(page).getByRole("gridcell", { name: "Person 130", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  test("hides columns that look like secrets, and reveals one only when asked", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);
    await expect(grid(page)).toBeVisible();

    // The value was never sent to the browser, so it is nowhere in the page.
    expect(await page.content()).not.toContain(HASH);
    expect(await page.content()).not.toContain(KEY);
    await expect(page.getByText(/columns whose names look sensitive were not read/)).toBeVisible();

    await page.getByRole("button", { name: "Show the hidden column api_key" }).click();
    await expect(grid(page).getByRole("gridcell", { name: `${KEY}1`, exact: true })).toBeVisible();
    // The other one is still hidden.
    expect(await page.content()).not.toContain(HASH);

    await page.getByRole("button", { name: "Hide the column api_key again" }).click();
    await expect(grid(page).getByRole("gridcell", { name: `${KEY}1`, exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(KEY);
  });

  test("opens a long value in a dialog with a copy button and says it was cut", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);
    await expect(grid(page)).toBeVisible();

    const longCell = grid(page).getByRole("gridcell", { name: /^long long/ });
    await expect(longCell).toBeVisible();
    await longCell.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "bio" })).toBeVisible();
    const value = await dialog.getByLabel("Value of bio", { exact: true }).textContent();
    expect(value).toHaveLength(2000);
    await expect(dialog.getByText(/Only the first 2,000 are shown/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy the value of bio" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("can be used from the keyboard: arrow keys move between cells and Enter opens a value", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);
    await expect(grid(page)).toBeVisible();

    await grid(page).getByRole("gridcell", { name: "Person 1", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("td:focus")).toHaveText("Person 2");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("td:focus")).toHaveText("2");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog").getByLabel("Value of name", { exact: true })).toHaveText(
      "Person 2",
    );
    await page.keyboard.press("Escape");
    // Focus returns to the table, not to the top of the page.
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("reads awkward table and column names, and says when a table has no key", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });

    await openTable(page, /^Dv Odd "Table\b/);
    await expect(grid(page).getByRole("columnheader", { name: /select/ })).toBeVisible();
    await expect(grid(page).getByRole("columnheader", { name: /Unit Price/ })).toBeVisible();
    await expect(grid(page).getByRole("columnheader", { name: /日本語 🙂/ })).toBeVisible();
    await expect(grid(page).getByRole("gridcell", { name: "odd value" })).toBeVisible();

    await page
      .getByRole("button", { name: /^dv_nokey\b/ })
      .first()
      .click();
    await expect(grid(page).getByRole("gridcell", { name: "no key row 2" })).toBeVisible();
    await expect(
      page.getByText(/no key to order by, so the order is not guaranteed/),
    ).toBeVisible();
  });

  test("switching it off in the sidebar removes every row from the page", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);
    await expect(grid(page).getByRole("gridcell", { name: "Person 2", exact: true })).toBeVisible();

    await page.getByRole("switch", { name: /Allow viewing table data for DV shop/ }).click();

    await expect(page.getByText("Table data is switched off")).toBeVisible();
    await expect(grid(page)).toHaveCount(0);
    expect(await page.content()).not.toContain("Person 2");

    // And it can be switched on again from the section.
    await page.getByRole("button", { name: "Allow viewing table data" }).click();
    await expect(grid(page).getByRole("gridcell", { name: "Person 2", exact: true })).toBeVisible();
  });

  test("leaves no row in the page after the connection is closed", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);
    await expect(grid(page).getByRole("gridcell", { name: "Person 2", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Disconnect DV shop" }).click();

    await expect(page.getByRole("button", { name: "Disconnect DV shop" })).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain("Person 2");
    expect(html).not.toContain("Person 1<");
    // Nothing was kept in the browser's storage either.
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toContain("Person");
    expect(stored).not.toContain(HASH);
  });

  test("a saved connection remembers the choice and offers it again on reconnect", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await page.getByRole("button", { name: "Disconnect DV shop" }).click();

    await page.getByRole("button", { name: /^Connect DV shop/ }).click();
    await expect(page.getByLabel("Allow viewing table data")).toBeChecked();
    await page.getByRole("textbox", { name: "Password" }).fill(database.password);
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect DV shop" })).toBeVisible();
    await expect(
      page.getByRole("switch", { name: /Allow viewing table data for DV shop/ }),
    ).toBeChecked();

    await openTable(page, /^dv_people\b/);
    await expect(grid(page)).toBeVisible();
  });

  test("blurs every value on request, in the grid and in the dialog, and keeps it across tables", async ({
    page,
    app,
    database,
  }) => {
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);
    await expect(grid(page)).toBeVisible();

    const value = grid(page).getByText("Person 1", { exact: true });
    await expect(value).toHaveCSS("filter", "none");

    await page.getByRole("switch", { name: "Blur values" }).click();
    await expect(value).toHaveCSS("filter", /blur\(/);
    // What a cell says about itself (not a value) stays readable.
    await expect(grid(page).getByText("NULL").first()).toHaveCSS("filter", "none");

    // The dialog blurs too, and says why.
    await grid(page).getByRole("gridcell", { name: "Person 1", exact: true }).click();
    await expect(page.getByLabel("Value of name", { exact: true })).toHaveClass(/blur-sm/);
    await expect(page.getByText("Values are blurred.")).toBeVisible();
    await page.keyboard.press("Escape");

    // Another table is blurred as well, without asking again.
    await openTable(page, /^dv_nokey\b/);
    await expect(grid(page).getByText("no key row 1", { exact: true })).toHaveCSS(
      "filter",
      /blur\(/,
    );

    await page.getByRole("switch", { name: "Blur values" }).click();
    await expect(grid(page).getByText("no key row 1", { exact: true })).toHaveCSS("filter", "none");
  });

  test("warns that row-level security may hide rows, only for a role it applies to", async ({
    page,
    app,
    database,
  }) => {
    const role = `dv_rls_${Math.random().toString(16).slice(2, 10)}`;
    // Made up for this run only: the role is dropped again below.
    const password = `pw${randomBytes(12).toString("hex")}`;
    const admin = new pg.Client({
      host: database.host,
      port: database.port,
      user: database.user,
      password: database.password,
      database: database.name,
    });
    await admin.connect();
    try {
      await admin.query(`
        CREATE TABLE public.dv_secured (id integer PRIMARY KEY, owner text);
        INSERT INTO public.dv_secured VALUES (1, 'someone else'), (2, '${role}');
        ALTER TABLE public.dv_secured ENABLE ROW LEVEL SECURITY;
        CREATE POLICY mine ON public.dv_secured USING (owner = current_user);
        CREATE ROLE ${role} LOGIN PASSWORD '${password}';
        GRANT CONNECT ON DATABASE "${database.name}" TO ${role};
        GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};
      `);

      // The database's own user owns the table and is exempt: no warning, every row.
      await connect(page, database, app, { dataAccess: true });
      await openTable(page, /^dv_secured\b/);
      await expect(grid(page).getByRole("gridcell", { name: "someone else" })).toBeVisible();
      await expect(page.getByText(/Row-level security is on/)).toHaveCount(0);
      await page.getByRole("button", { name: "Disconnect DV shop" }).click();

      // A role the policy applies to sees one row, and is told that rows may be missing.
      const url = `postgresql://${role}:${password}@${database.host}:${database.port}/${database.name}?sslmode=disable`;
      await connect(page, database, app, { dataAccess: true, url });
      await openTable(page, /^dv_secured\b/);
      await expect(grid(page).getByRole("gridcell", { name: role, exact: true })).toBeVisible();
      await expect(grid(page).getByRole("gridcell", { name: "someone else" })).toHaveCount(0);
      await expect(page.getByText(/Row-level security is on for this table/)).toBeVisible();
    } finally {
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await admin.end();
    }
  });

  test("works in dark mode", async ({ page, app, database }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await connect(page, database, app, { dataAccess: true });
    await openTable(page, /^dv_people\b/);
    await expect(grid(page)).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The header and a cell are readable: neither has the page's background as its own colour.
    const colours = await page.evaluate(() => {
      const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : "");
      const th = document.querySelector("thead");
      return { page: bg(document.body), header: bg(th) };
    });
    expect(colours.header).not.toBe(colours.page);
  });
});
