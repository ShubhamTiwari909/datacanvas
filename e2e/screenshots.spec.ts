/**
 * README screenshots, taken from the real packaged app against the sample shop
 * database (examples/ecommerce.sql). Not part of the normal run: it only does
 * anything when SCREENSHOTS=1 (see `npm run screenshots`), and writes into
 * docs/images/. Re-run it whenever the interface changes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const out = (name: string) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/images", name);

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate the README images");

test("README screenshots", async ({ page, app, database }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.link);
  await expect(page.getByText("Welcome to DataCanvas")).toBeVisible();

  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sample shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Sample shop" })).toBeVisible();

  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("article", { name: "Schema public" })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("overview.png") });
  await page.getByRole("tab", { name: "Paths" }).click();
  await page.getByLabel("From table").selectOption({ label: "public.order_items" });
  await page.getByLabel("To table").selectOption({ label: "public.users" });
  await expect(page.getByText("Shortest route: 2 joins")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("paths.png") });

  await page.getByRole("tab", { name: "Health" }).click();
  await expect(page.getByText(/Checked \d+ tables?/)).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("health.png") });
  await page.getByRole("tab", { name: "Canvas" }).click();

  await page.getByRole("button", { name: "Add all tables of public to the canvas" }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("menuitem", { name: /Group related tables/ }).click();
  await page.waitForTimeout(1500);
  await page.locator('.react-flow__node[data-id*="orders"]').first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("canvas.png") });

  // The same canvas in dark mode.
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: out("canvas-dark.png") });
});

test("README screenshot of the SQL tab", async ({ page, app, database }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sample shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Sample shop" })).toBeVisible();
  await page.getByRole("tab", { name: "SQL" }).click();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.insertText(
    "SELECT t.table_name, count(*) AS columns,\n       string_agg(c.column_name, ', ' ORDER BY c.ordinal_position) AS column_names\nFROM information_schema.tables t\nJOIN information_schema.columns c USING (table_schema, table_name)\nWHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'\nGROUP BY t.table_name\nORDER BY columns DESC, t.table_name",
  );
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("region", { name: "Result" }).getByRole("grid")).toBeVisible();
  // The role note is about the test database's superuser: dismissed for the picture.
  await page.waitForTimeout(600);
  await page.screenshot({ path: out("sql.png") });
});
