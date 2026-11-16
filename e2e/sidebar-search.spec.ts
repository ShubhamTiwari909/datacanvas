/**
 * The sidebar table search (docs/sidebar-table-search-plan.md): a table in a
 * schema that was never opened is found, the tree comes back when the box is
 * cleared, and the typed text is never sent to the server.
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

async function plant(database: TestDb, sql: string): Promise<void> {
  const client = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function connect(page: Page, link: string, url: string): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Search shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Search shop" })).toBeVisible();
}

test("finds a table in a schema that was never opened, and sends no text", async ({
  page,
  app,
  database,
}) => {
  await plant(
    database,
    `CREATE SCHEMA warehouse;
     CREATE TABLE warehouse.stock_levels (id integer PRIMARY KEY);
     CREATE TABLE warehouse."Odd_50%_Name" (id integer PRIMARY KEY);
     CREATE VIEW warehouse.low_stock AS SELECT id FROM warehouse.stock_levels;`,
  );

  // Every request URL and body, to check the text never leaves the browser.
  const sent: string[] = [];
  page.on("request", (request) => sent.push(`${request.url()} ${request.postData() ?? ""}`));

  await connect(page, app.link, database.url);
  const sidebar = page.getByRole("complementary", { name: "Connections and schema explorer" });
  const search = sidebar.getByRole("textbox", { name: "Find a table" });

  // The warehouse schema is closed, so its tables are not on screen.
  await expect(sidebar.getByRole("button", { name: /^warehouse$/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(sidebar.getByRole("button", { name: /^stock_levels\b/ })).toHaveCount(0);

  await search.fill("STOCK");
  const status = sidebar.getByRole("status");
  await expect(status).toHaveText(/^2 of \d+ tables and views$/);
  // The name that starts with the text comes first; the view is listed too.
  const matches = sidebar.getByRole("list", { name: "Matches in warehouse" }).getByRole("button");
  await expect(matches).toHaveText([/^stock_levels/, /^low_stock/]);
  await expect(matches.first().locator("mark")).toHaveText("stock");
  // Schemas without a match are gone from the results, and the tree is hidden.
  await expect(sidebar.getByRole("list", { name: "Matches in public" })).toHaveCount(0);
  await expect(sidebar.getByRole("list", { name: "Schemas" })).toBeHidden();

  // `%` is an ordinary character.
  await search.fill("50%");
  await expect(status).toHaveText(/^1 of \d+/);
  await expect(matches).toHaveText([/^Odd_50%_Name/]);

  // Nothing matches: a sentence that does not repeat the text.
  await search.fill("zzz-nothing");
  await expect(status).toHaveText("No table matches this text.");

  // Canvas view: clicking a result adds the table to the canvas.
  await search.fill("stock_lev");
  await matches.first().click();
  await expect(page.locator('.react-flow__node[data-id*="stock_levels"]')).toBeVisible();
  await expect(matches.first()).toHaveAttribute("aria-current", "true");
  await expect(matches.first().getByLabel("on the canvas")).toBeVisible();

  // Escape clears the box and the tree comes back as it was.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(sidebar.getByRole("list", { name: "Schemas" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^warehouse$/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  // Details view: clicking a result shows the table's details. The clear button empties the box.
  await page.getByRole("tab", { name: "Table details" }).click();
  await search.fill("low_");
  await matches.first().click();
  await expect(page.getByRole("heading", { name: /low_stock/ })).toBeVisible();
  await sidebar.getByRole("button", { name: "Clear the table search" }).click();
  await expect(search).toHaveValue("");

  // None of the typed text was sent anywhere. (Only texts that are not also a
  // table name: opening a table rightly requests it by name.)
  for (const text of ["STOCK", "50%", "50%25", "zzz-nothing"]) {
    expect(sent.filter((line) => line.includes(text))).toEqual([]);
  }
});
