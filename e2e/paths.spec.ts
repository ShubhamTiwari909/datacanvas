/**
 * The Paths tab, end to end: a route across two foreign keys, the generated
 * join, swapping direction, a pair with no route, and jumping to the canvas.
 */
import { expect, test } from "./fixtures";

test("paths finds a route, writes the join and shows it on the canvas", async ({
  page,
  app,
  database,
}) => {
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Paths shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Paths shop" })).toBeVisible();

  await page.getByRole("tab", { name: "Paths" }).click();
  await expect(page.getByText("Pick two tables")).toBeVisible();

  // order_items -> orders -> users: two joins, child to parent.
  await page.getByLabel("From table").selectOption({ label: "public.order_items" });
  await page.getByLabel("To table").selectOption({ label: "public.users" });
  await expect(page.getByText("Shortest route: 2 joins")).toBeVisible();
  const route = page.getByRole("article", { name: "Route" });
  await expect(route).toContainText('JOIN "public"."orders" AS t2 ON t1."order_id" = t2."id"');
  await expect(route).toContainText('JOIN "public"."users" AS t3 ON t2."user_id" = t3."id"');
  await expect(route.getByText("at most one row").first()).toBeVisible();

  // Swapped: parent to children, which can multiply rows.
  await page.getByRole("button", { name: "Swap the two tables" }).click();
  await expect(page.getByLabel("From table")).toHaveValue(/\d+/);
  await expect(page.getByText(/one starting row can appear several times/)).toBeVisible();
  await expect(page.getByRole("article", { name: "Route" })).toContainText(
    'FROM "public"."users" AS t1',
  );

  // No declared foreign keys connect regions and users.
  await page.getByLabel("From table").selectOption({ label: "public.regions" });
  await page.getByLabel("To table").selectOption({ label: "public.users" });
  await expect(page.getByText(/No route: no chain of declared foreign keys/)).toBeVisible();

  // The same table on both sides is explained, not searched.
  await page.getByLabel("To table").selectOption({ label: "public.regions" });
  await expect(page.getByText(/These are the same table/)).toBeVisible();

  // Show a route on the canvas.
  await page.getByLabel("From table").selectOption({ label: "public.order_items" });
  await page.getByLabel("To table").selectOption({ label: "public.users" });
  await page.getByRole("button", { name: "Show on canvas" }).click();
  await expect(page.getByRole("tab", { name: "Canvas", selected: true })).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id*="order_items"]').first()).toBeVisible();
});
