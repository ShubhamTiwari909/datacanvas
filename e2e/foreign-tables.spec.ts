/**
 * Foreign tables (postgres_fdw) in the real UI: listed, labelled, counted in the
 * overview, drawn on the canvas and described in the inspector. The test skips
 * itself when the server has no postgres_fdw extension.
 */
import pg from "pg";
import { expect, test } from "./fixtures";

test("a foreign table is listed, labelled and shown on the canvas", async ({
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
    await client.query("CREATE EXTENSION postgres_fdw");
  } catch {
    await client.end();
    test.skip(true, "this PostgreSQL has no postgres_fdw extension");
  }
  await client.query(`
    CREATE SERVER loopback FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host '${database.host}', port '${database.port}', dbname '${database.name}');
    CREATE FOREIGN TABLE public.remote_users (id integer, email text)
      SERVER loopback OPTIONS (table_name 'users');
  `);
  await client.end();

  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("FDW shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect FDW shop" })).toBeVisible();

  // Listed in the schema tree.
  await expect(page.getByRole("button", { name: /^remote_users\b/ }).first()).toBeVisible();

  // Counted in the overview.
  await page.getByRole("tab", { name: "Overview" }).click();
  const card = page.getByRole("article", { name: "Schema public" });
  await expect(card.getByText(/1 foreign table\b/)).toBeVisible();

  // Drawn on the canvas, and described as a foreign table in the inspector.
  await card.getByRole("button", { name: "Add to canvas" }).click();
  // Search selects and focuses the node (nodes outside the view are not drawn).
  await page.getByRole("combobox").first().fill("remote_users");
  await page.getByRole("combobox").first().press("Enter");
  await expect(page.locator('.react-flow__node[data-id*="remote_users"]').first()).toBeVisible();
  await expect(page.getByText("Foreign table").first()).toBeVisible();

  // Health does not flag it as a table without a primary key: the keys live on the remote side.
  await page.getByRole("tab", { name: "Health" }).click();
  await expect(page.getByText(/Checked \d+ tables?/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Show remote_users on the canvas" })).toHaveCount(
    0,
  );
});
