/**
 * The page frame: the document itself must never scroll, however long the table
 * list or the rows grid is. A long list once let the page scroll, which slid the
 * app up and left a blank area under the canvas (the screen-reader-only labels in
 * each row are absolutely positioned and escaped the scroll areas that hold them).
 */
import pg from "pg";
import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/** How tall the page is against the window, and how far it has scrolled. */
const pageScroll = (page: Page) =>
  page.evaluate(() => ({
    document: document.documentElement.scrollHeight,
    window: window.innerHeight,
    scrolledBy: window.scrollY,
  }));

test("the page does not scroll with a long table list or a full page of rows", async ({
  page,
  app,
  database,
}) => {
  const client = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await client.connect();
  try {
    // Many tables with long names, as in a CMS schema, and one table with 200 rows and a hidden column.
    for (let i = 0; i < 80; i += 1) {
      await client.query(
        `CREATE TABLE public."lay_table_with_a_rather_long_name_${String(i).padStart(2, "0")}" (id integer PRIMARY KEY)`,
      );
    }
    await client.query(`
      CREATE TABLE public.lay_rows (id integer PRIMARY KEY, name text, password_hash text);
      INSERT INTO public.lay_rows SELECT i, 'Row ' || i, 'x' FROM generate_series(1, 200) AS i;
    `);
  } finally {
    await client.end();
  }

  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Layout shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Layout shop" })).toBeVisible();

  // A long list in the sidebar: the page is exactly one screen tall.
  const last = page.getByRole("button", { name: /^lay_table_with_a_rather_long_name_79\b/ });
  await expect(last).toBeAttached();
  let size = await pageScroll(page);
  expect(size.document).toBeLessThanOrEqual(size.window);

  // Bringing a row far down the list into view scrolls the list, never the page.
  await last.scrollIntoViewIfNeeded();
  size = await pageScroll(page);
  expect(size.scrolledBy).toBe(0);
  expect(size.document).toBeLessThanOrEqual(size.window);

  // A full page of rows, with a hidden column (its cells hold screen-reader-only text).
  await page.getByRole("tab", { name: "Table details" }).click();
  await page
    .getByRole("button", { name: /^lay_rows\b/ })
    .first()
    .click();
  await expect(page.getByRole("grid")).toBeVisible();
  await page.getByLabel("Rows per page").selectOption("200");
  await expect(page.getByRole("gridcell", { name: "Row 200", exact: true })).toBeVisible();
  size = await pageScroll(page);
  expect(size.scrolledBy).toBe(0);
  expect(size.document).toBeLessThanOrEqual(size.window);
});
