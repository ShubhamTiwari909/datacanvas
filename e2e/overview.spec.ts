/**
 * The Overview tab, end to end: counts per schema, relationships, and jumping
 * from a table name to the canvas.
 */
import { expect, test } from "./fixtures";

test("overview shows each schema and jumps to the canvas", async ({ page, app, database }) => {
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Overview shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Overview shop" })).toBeVisible();

  await page.getByRole("tab", { name: "Overview" }).click();

  // The sample shop has a public and an analytics schema.
  const publicCard = page.getByRole("article", { name: "Schema public" });
  await expect(publicCard).toBeVisible();
  await expect(page.getByRole("article", { name: "Schema analytics" })).toBeVisible();
  await expect(publicCard.getByText(/\d+ tables?/).first()).toBeVisible();

  // Relationships are counted from the real foreign keys: orders is among the most connected.
  await expect(publicCard.getByText("Most connected")).toBeVisible();
  await expect(publicCard.getByRole("button", { name: "Show orders on the canvas" })).toBeVisible();

  // Clicking a table switches to the canvas with that table on it.
  await publicCard.getByRole("button", { name: "Show orders on the canvas" }).first().click();
  await expect(page.getByRole("tab", { name: "Canvas", selected: true })).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id*="orders"]').first()).toBeVisible();
});
