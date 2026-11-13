/**
 * The core user journey, end to end, against the packaged app:
 * connect -> browse tables -> open the canvas -> move a node -> save ->
 * reload -> restore -> disconnect. Also checks the security basics a real
 * browser sees: no token in the address bar, the API refuses a bare request.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Where `orders` sits relative to `users`, in node widths: independent of zoom and panning. */
async function relativePosition(page: Page): Promise<{ x: number; y: number }> {
  const a = await page.locator('.react-flow__node[data-id*="orders"]').first().boundingBox();
  const b = await page.locator('.react-flow__node[data-id*="users"]').first().boundingBox();
  if (!a || !b) throw new Error("nodes are not on screen");
  return { x: (a.x - b.x) / a.width, y: (a.y - b.y) / a.width };
}

test("connect, browse, canvas, save, reload, restore, disconnect", async ({
  page,
  app,
  database,
}) => {
  // 1. The private link opens the app and the token disappears from the address bar.
  await page.goto(app.link);
  await expect(page).toHaveURL(`${app.origin}/`);
  await expect(page.getByText("Backend status: Connected")).toBeVisible();
  await expect(page.getByText("Welcome to DataCanvas")).toBeVisible();

  // 2. Connect with a connection string.
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("E2E shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect E2E shop" })).toBeVisible();

  // 3. Browse: the schema tree lists the sample tables.
  for (const table of ["users", "orders", "order_items", "products"]) {
    await expect(
      page.getByRole("button", { name: new RegExp(`^${table}\\b`) }).first(),
    ).toBeVisible();
  }

  // 4. Put tables on the canvas.
  await page.getByRole("button", { name: "Add all tables of public to the canvas" }).click();
  const orders = page.locator('.react-flow__node[data-id*="orders"]').first();
  await expect(orders).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();

  // 5. Move a node by dragging its header.
  const before = await orders.boundingBox();
  if (!before) throw new Error("orders node has no box");
  await page.mouse.move(before.x + 40, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 140, before.y + 90, { steps: 8 });
  await page.mouse.up();
  const after = await orders.boundingBox();
  expect(Math.round((after?.x ?? 0) - before.x)).toBeGreaterThan(50);

  // 6. The connection is saved on connect, and the layout autosaves (debounced).
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.waitForTimeout(2000);

  const arranged = await relativePosition(page);

  // 7. Reload: the server keeps the open connection, so the page finds it again.
  await page.reload();
  await expect(page.getByRole("button", { name: "Disconnect E2E shop" })).toBeVisible();

  // 8. Disconnect. The saved connection stays listed (without its password).
  await page.getByRole("button", { name: "Disconnect E2E shop" }).click();
  await expect(page.getByRole("button", { name: "Disconnect E2E shop" })).toHaveCount(0);
  await page.getByRole("button", { name: /Connect E2E shop/ }).click();

  // 9. Reconnect: DataCanvas asks for the password again, then restores the layout.
  await page.getByRole("textbox", { name: "Password" }).fill(database.password);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect E2E shop" })).toBeVisible();
  const restored = page.locator('.react-flow__node[data-id*="orders"]').first();
  await expect(restored).toBeVisible();
  // Same arrangement as before the disconnect.
  const after2 = await relativePosition(page);
  expect(after2.x).toBeCloseTo(arranged.x, 1);
  expect(after2.y).toBeCloseTo(arranged.y, 1);
});

test("the API refuses requests without the session", async ({ app, request }) => {
  expect((await request.get(`${app.origin}/api/health`)).status()).toBe(200);
  expect((await request.get(`${app.origin}/api/connections`)).status()).toBe(401);
  const post = await request.post(`${app.origin}/api/connections/test`, {
    headers: { origin: "http://evil.example" },
    data: {},
  });
  expect(post.status()).toBe(403);
});
