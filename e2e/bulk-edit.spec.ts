/**
 * Bulk editing, end to end (1.9.0, D5): rows are chosen in the grid (one by one, a range with shift, a page, across
 * pages), one value is set on all of them or they are deleted, each through a preview; a row that changed since it
 * was loaded is left out and said so before anything is written; nothing is written when the preview is cancelled.
 * axe on the toolbar and the dialogs in both themes and on a phone.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

async function sql<Row extends Record<string, unknown> = Record<string, unknown>>(
  database: TestDb,
  text: string,
): Promise<Row[]> {
  const c = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await c.connect();
  try {
    return (await c.query(text)).rows as Row[];
  } finally {
    await c.end();
  }
}

async function axeOn(page: Page, name: string, inDialog: boolean): Promise<void> {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async (scoped) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            c: Element,
            o: object,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: unknown[] }>;
            }>;
          }>;
        };
      }
    ).axe;
    const bar = document.querySelector('[data-slot="data-toolbar"]');
    const context = (scoped ? document.querySelector('[role="dialog"]') : bar) ?? document.body;
    return axe.run(context, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  }, inDialog);
  const found = result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(" | ")}`,
  );
  console.log(`axe ${name}: ${found.join(" || ")}`);
  expect.soft(found, `axe on ${name}`).toEqual([]);
}

const grid = (page: Page) => page.getByRole("grid");
const chosen = (page: Page) => page.getByRole("group", { name: "Chosen rows" });
const pick = (page: Page, n: number) =>
  page.getByRole("checkbox", { name: `Select row ${n}`, exact: true });

test.describe("bulk editing", () => {
  test.beforeEach(async ({ page, writableApp, database }) => {
    await sql(
      database,
      `CREATE TABLE public.bk_items (id integer PRIMARY KEY, status text, qty integer CHECK (qty >= 0));
       INSERT INTO public.bk_items SELECT i, 'new', i FROM generate_series(1, 60) i;`,
    );
    await page.goto(writableApp.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("Bk shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByLabel("Allow viewing table data").check();
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect Bk shop" })).toBeVisible();
    await page.getByRole("switch", { name: "Allow changes to Bk shop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
    await dialog.getByRole("button", { name: "Allow changes" }).click();
    await expect(page.getByText("Writes on")).toBeVisible();
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^bk_items\b/ })
      .first()
      .click();
    await expect(grid(page)).toBeVisible();
  });

  test("choose rows, a range with shift, a page, and across pages", async ({ page }) => {
    await expect(chosen(page)).toHaveCount(0);
    await pick(page, 2).click();
    await expect(chosen(page).getByRole("status")).toContainText("1 row chosen");
    await pick(page, 5).click({ modifiers: ["Shift"] });
    await expect(chosen(page).getByRole("status")).toContainText("4 rows chosen");
    await expect(pick(page, 3)).toBeChecked();
    await expect(pick(page, 6)).not.toBeChecked();

    // The header chooses the rows of the page; a second press lets go of them.
    const all = page.getByRole("checkbox", { name: "Select all rows of this page" });
    await all.click();
    await expect(chosen(page).getByRole("status")).toContainText("50 rows chosen");
    await all.click();
    await expect(chosen(page)).toHaveCount(0);

    // The choice stays when the page changes.
    await pick(page, 1).click();
    await page.getByRole("button", { name: "Next" }).click();
    // Rows 51 and on: the id column of the second page (the qty column holds the same numbers).
    await expect(grid(page).locator("tbody tr td[data-col='0']").first()).toHaveText("51");
    await pick(page, 1).click();
    await expect(chosen(page).getByRole("status")).toContainText("2 rows chosen");
    await chosen(page).getByRole("button", { name: "Clear" }).click();
    await expect(chosen(page)).toHaveCount(0);
  });

  test("sets one value on the chosen rows through a preview, and only on them", async ({
    page,
    database,
  }) => {
    await pick(page, 2).click();
    await pick(page, 4).click({ modifiers: ["Shift"] });
    await chosen(page).getByRole("button", { name: "Set a value" }).click();
    const form = page.getByRole("dialog", { name: /Set a value on 3 rows/ });
    await form.getByLabel("Column").selectOption("status");
    await form.getByRole("textbox", { name: "New value" }).fill("done");
    await form.getByRole("button", { name: "Preview" }).click();

    const preview = page.getByRole("dialog", { name: /Set status on 3 rows/ });
    await expect(preview.getByText(/Sets status on 3 rows/)).toBeVisible();
    // One statement, shown once, with how many times it runs.
    const statement = preview.getByLabel("The statement that will run");
    await expect(statement).toContainText("the same statement runs for each of 3 rows");
    await expect(statement.getByText(/UPDATE/)).toHaveCount(1);
    // Nothing is written by a preview.
    expect(
      await sql(database, "SELECT count(*)::int AS n FROM public.bk_items WHERE status = 'done'"),
    ).toEqual([{ n: 0 }]);
    await axeOn(page, "the preview of a bulk change", true);

    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("3 rows were changed.")).toBeVisible();
    expect(
      await sql(database, "SELECT id FROM public.bk_items WHERE status = 'done' ORDER BY id"),
    ).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
    // The rows are let go of after the change.
    await expect(chosen(page)).toHaveCount(0);
  });

  test("leaves out a row that changed since it was loaded, and says so before anything is written", async ({
    page,
    database,
  }) => {
    await pick(page, 1).click();
    await pick(page, 3).click({ modifiers: ["Shift"] });
    // Someone else changes row 2 after the page was read.
    await sql(database, "UPDATE public.bk_items SET status = 'someone-else' WHERE id = 2");
    await chosen(page).getByRole("button", { name: "Set a value" }).click();
    const form = page.getByRole("dialog", { name: /Set a value on 3 rows/ });
    await form.getByRole("textbox", { name: "New value" }).fill("done");
    await form.getByRole("button", { name: "Preview" }).click();

    const preview = page.getByRole("dialog", { name: /Set status on 3 rows/ });
    await expect(preview.getByText(/Sets status on 2 rows/)).toBeVisible();
    await expect(
      preview.getByRole("status").filter({ hasText: "1 row changed since you loaded it" }),
    ).toBeVisible();
    expect(
      await sql(database, "SELECT count(*)::int AS n FROM public.bk_items WHERE status = 'done'"),
    ).toEqual([{ n: 0 }]);
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("2 rows were changed.")).toBeVisible();
    expect(
      await sql(database, "SELECT id, status FROM public.bk_items WHERE id <= 3 ORDER BY id"),
    ).toEqual([
      { id: 1, status: "done" },
      { id: 2, status: "someone-else" },
      { id: 3, status: "done" },
    ]);
  });

  test("changes nothing when the database refuses one row, and says so without the value", async ({
    page,
    database,
  }) => {
    await pick(page, 1).click();
    await pick(page, 3).click({ modifiers: ["Shift"] });
    await chosen(page).getByRole("button", { name: "Set a value" }).click();
    const form = page.getByRole("dialog", { name: /Set a value on 3 rows/ });
    await form.getByLabel("Column").selectOption("qty");
    await form.getByRole("textbox", { name: "New value" }).fill("-5");
    await form.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: /Set qty on 3 rows/ });
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(preview.getByRole("alert")).toContainText("The change was not applied");
    await expect(preview.getByRole("alert")).not.toContainText("-5");
    expect(
      await sql(database, "SELECT id, qty FROM public.bk_items WHERE id <= 3 ORDER BY id"),
    ).toEqual([
      { id: 1, qty: 1 },
      { id: 2, qty: 2 },
      { id: 3, qty: 3 },
    ]);
  });

  test("deletes the chosen rows after reading what it does, and only those", async ({
    page,
    database,
  }) => {
    await pick(page, 5).click();
    await pick(page, 7).click({ modifiers: ["Shift"] });
    await chosen(page).getByRole("button", { name: "Delete 3 rows" }).click();
    const preview = page.getByRole("dialog", { name: /Delete 3 rows of/ });
    await expect(preview.getByText(/Deletes 3 rows/)).toBeVisible();
    // A delete cannot be applied until it has been read.
    await expect(preview.getByRole("button", { name: "Apply" })).toBeDisabled();
    await preview.getByLabel(/I have read this/).check();
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("3 rows were deleted.")).toBeVisible();
    expect(await sql(database, "SELECT count(*)::int AS n FROM public.bk_items")).toEqual([
      { n: 57 },
    ]);
    expect(
      await sql(database, "SELECT id FROM public.bk_items WHERE id BETWEEN 4 AND 8 ORDER BY id"),
    ).toEqual([{ id: 4 }, { id: 8 }]);
  });

  test("nothing is written when the preview is cancelled", async ({ page, database }) => {
    await pick(page, 1).click();
    await chosen(page).getByRole("button", { name: "Delete 1 row" }).click();
    const preview = page.getByRole("dialog", { name: /Delete 1 row of/ });
    await expect(preview.getByText(/Deletes 1 row/)).toBeVisible();
    await preview.getByRole("button", { name: "Cancel" }).click();
    expect(await sql(database, "SELECT count(*)::int AS n FROM public.bk_items")).toEqual([
      { n: 60 },
    ]);
    // The rows are still chosen: cancelling a preview is not letting go of them.
    await expect(chosen(page).getByRole("status")).toContainText("1 row chosen");
  });

  test("passes axe in light, in dark and on a phone", async ({ page }) => {
    await pick(page, 1).click();
    await pick(page, 2).click();
    await axeOn(page, "the toolbar with chosen rows (light)", false);
    await chosen(page).getByRole("button", { name: "Set a value" }).click();
    await expect(page.getByRole("dialog", { name: /Set a value on 2 rows/ })).toBeVisible();
    await axeOn(page, "the bulk dialog (light)", true);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await axeOn(page, "the toolbar with chosen rows (dark)", false);
    await chosen(page).getByRole("button", { name: "Set a value" }).click();
    await axeOn(page, "the bulk dialog (dark)", true);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByRole("dialog", { name: /Set a value on 2 rows/ })).toBeVisible();
    await axeOn(page, "the bulk dialog (phone)", true);
  });
});
