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
  await page.screenshot({ path: out("welcome.png") });

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
});
