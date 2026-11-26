/**
 * A change of every row the filter matches, end to end (`docs/write-side-v2-plan.md`, section 6): "Set a value on all
 * matching rows" and "Delete all matching rows" are offered only with a condition; the preview counts the rows; Apply
 * needs the tick and that count typed; a row deleted between the preview and the apply refuses the whole change and
 * offers a fresh preview. axe on the toolbar and the dialogs.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb, settleForAxe } from "./fixtures";

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
  await settleForAxe(page);
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
  expect.soft(found, `axe on ${name}`).toEqual([]);
}

const grid = (page: Page) => page.getByRole("grid");
const matching = (page: Page) => page.getByRole("group", { name: "Rows that match the filter" });
const panel = (page: Page) => page.getByRole("form", { name: "Add a filter" });
const counted = (page: Page) =>
  page.getByRole("dialog").getByRole("status", { name: "What the preview counted" });

/** Open the filter panel if it is closed, and add one condition. */
async function addFilter(page: Page, column: string, condition: string, value: string) {
  if ((await panel(page).count()) === 0) {
    await page.getByRole("button", { name: /^Filter\b/ }).click();
  }
  await panel(page).getByLabel("Column").selectOption(column);
  await panel(page).getByLabel("Condition").selectOption({ label: condition });
  await panel(page).getByLabel("Value").fill(value);
  await panel(page).getByRole("button", { name: "Add filter" }).click();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/** Every third row (20 of 60) is on hold: the rows the filter `status equals hold` matches. */
const HOLD = "SELECT id FROM public.mr_items WHERE id % 3 = 0 ORDER BY id";

test.describe("changes of the rows a filter matches", () => {
  test.beforeEach(async ({ page, writableApp, database }) => {
    await sql(
      database,
      `CREATE TABLE public.mr_items (id integer PRIMARY KEY, status text, qty integer);
       INSERT INTO public.mr_items
         SELECT i, CASE WHEN i % 3 = 0 THEN 'hold' ELSE 'new' END, i FROM generate_series(1, 60) i;`,
    );
    await page.goto(writableApp.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("Mr shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByLabel("Allow viewing table data").check();
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect Mr shop" })).toBeVisible();
    await page.getByRole("switch", { name: "Allow changes to Mr shop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
    await dialog.getByRole("button", { name: "Allow changes" }).click();
    await expect(page.getByText("Writes on")).toBeVisible();
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^mr_items\b/ })
      .first()
      .click();
    await expect(grid(page)).toBeVisible();
    // Rows can be edited: "Add row" is there.
    await expect(page.getByRole("button", { name: "Add row" })).toBeVisible();
  });

  test("offers nothing without a condition, and goes again when the filter is cleared", async ({
    page,
  }) => {
    await expect(matching(page)).toHaveCount(0);
    await addFilter(page, "status", "equals", "hold");
    await expect(matching(page)).toBeVisible();
    await expect(
      matching(page).getByRole("button", { name: "Set a value on all matching rows" }),
    ).toBeVisible();
    await expect(
      matching(page).getByRole("button", { name: "Delete all matching rows" }),
    ).toBeVisible();
    await axeOn(page, "the toolbar with a filter", false);
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await axeOn(page, "the toolbar with a filter (dark)", false);
    await matching(page).getByRole("button", { name: "Set a value on all matching rows" }).click();
    await expect(
      page.getByRole("dialog", { name: "Set a value on all matching rows" }),
    ).toBeVisible();
    await axeOn(page, "the set-a-value form (dark)", true);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(matching(page)).toHaveCount(0);
  });

  test("sets a value on every matching row once the count is typed", async ({ page, database }) => {
    await addFilter(page, "status", "equals", "hold");
    await matching(page).getByRole("button", { name: "Set a value on all matching rows" }).click();
    const form = page.getByRole("dialog", { name: "Set a value on all matching rows" });
    await expect(form.getByText(/Rows are chosen by the filter/)).toBeVisible();
    // The key is not offered.
    await expect(form.getByLabel("Column").locator("option")).toHaveText([
      "status (text)",
      "qty (integer)",
    ]);
    await axeOn(page, "the set-a-value form", true);
    await form.getByLabel("Column").selectOption("status");
    await form.getByRole("textbox", { name: "New value" }).fill("done");
    await form.getByRole("button", { name: "Preview" }).click();

    const preview = page.getByRole("dialog", { name: /Set status on all matching rows of/ });
    await expect(counted(page)).toHaveText("20 rows");
    await expect(preview.getByText(/Sets status on the 20 rows of/)).toBeVisible();
    await expect(
      preview.getByText(/Rows are found by their key \(id\) when you apply/),
    ).toBeVisible();
    const apply = preview.getByRole("button", { name: "Apply" });
    await expect(apply).toBeDisabled();
    // Checked while Apply is disabled: the colours of the enabled destructive button are the shared Button's.
    await axeOn(page, "the preview of a change of matching rows", true);
    await preview.getByLabel(/I have read this/).check();
    // The tick alone is not enough.
    await expect(apply).toBeDisabled();
    await preview.getByRole("textbox", { name: "Type 20 to confirm" }).fill("20");
    await expect(apply).toBeEnabled();
    // A preview writes nothing.
    expect(
      await sql(database, "SELECT count(*)::int AS n FROM public.mr_items WHERE status = 'done'"),
    ).toEqual([{ n: 0 }]);

    await apply.click();
    await expect(page.getByText("20 rows were changed.")).toBeVisible();
    expect(
      await sql(database, "SELECT id FROM public.mr_items WHERE status = 'done' ORDER BY id"),
    ).toEqual(await sql(database, HOLD));
    expect(
      await sql(database, "SELECT count(*)::int AS n FROM public.mr_items WHERE status = 'new'"),
    ).toEqual([{ n: 40 }]);
    // The grid was read again: no row is on hold now.
    await expect(page.getByText("No rows match these filters.")).toBeVisible();
  });

  test("deletes every matching row once the count is typed", async ({ page, database }) => {
    await addFilter(page, "status", "equals", "hold");
    await matching(page).getByRole("button", { name: "Delete all matching rows" }).click();
    const preview = page.getByRole("dialog", { name: /Delete all matching rows of/ });
    await expect(counted(page)).toHaveText("20 rows");
    await expect(preview.getByText(/Deletes the 20 rows of/)).toBeVisible();
    await preview.getByLabel(/I have read this/).check();
    // Spaces around the count are ignored.
    await preview.getByRole("textbox", { name: "Type 20 to confirm" }).fill(" 20 ");
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("20 rows were deleted.")).toBeVisible();
    expect(await sql(database, "SELECT count(*)::int AS n FROM public.mr_items")).toEqual([
      { n: 40 },
    ]);
    expect(await sql(database, HOLD)).toEqual([]);
  });

  test("keeps Apply disabled while the count typed is wrong, and writes nothing", async ({
    page,
    database,
  }) => {
    await addFilter(page, "status", "equals", "hold");
    await matching(page).getByRole("button", { name: "Delete all matching rows" }).click();
    const preview = page.getByRole("dialog", { name: /Delete all matching rows of/ });
    await expect(counted(page)).toHaveText("20 rows");
    await preview.getByLabel(/I have read this/).check();
    const typed = preview.getByRole("textbox", { name: "Type 20 to confirm" });
    const apply = preview.getByRole("button", { name: "Apply" });
    for (const wrong of ["", "19", "21", "2O", "-20", "20.5", "2,0"]) {
      await typed.fill(wrong);
      await expect(apply, wrong).toBeDisabled();
    }
    // Enter in the field does not apply either.
    await typed.press("Enter");
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await sql(database, "SELECT count(*)::int AS n FROM public.mr_items")).toEqual([
      { n: 60 },
    ]);
  });

  test("refuses the whole change when a matching row is deleted after the preview", async ({
    page,
    database,
  }) => {
    await addFilter(page, "status", "equals", "hold");
    await matching(page).getByRole("button", { name: "Set a value on all matching rows" }).click();
    const form = page.getByRole("dialog", { name: "Set a value on all matching rows" });
    await form.getByLabel("Column").selectOption("qty");
    await form.getByRole("textbox", { name: "New value" }).fill("0");
    await form.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: /Set qty on all matching rows of/ });
    await expect(counted(page)).toHaveText("20 rows");

    // Another session deletes one of the rows the preview counted.
    await sql(database, "DELETE FROM public.mr_items WHERE id = 30");

    await preview.getByLabel(/I have read this/).check();
    await preview.getByRole("textbox", { name: "Type 20 to confirm" }).fill("20");
    await preview.getByRole("button", { name: "Apply" }).click();
    const alert = preview.getByRole("alert");
    await expect(alert).toContainText("The change was not applied");
    await expect(alert).toContainText(
      "A row that matched the filter was deleted, or its key changed, since the preview, so nothing was changed. Preview again.",
    );
    // Nothing changed: every other row keeps its quantity.
    expect(
      await sql(database, "SELECT count(*)::int AS n FROM public.mr_items WHERE qty <> id"),
    ).toEqual([{ n: 0 }]);
    expect(await sql(database, "SELECT count(*)::int AS n FROM public.mr_items")).toEqual([
      { n: 59 },
    ]);

    // A fresh preview finds the rows that match now.
    await alert.getByRole("button", { name: "Preview again" }).click();
    await expect(counted(page)).toHaveText("19 rows");
    await expect(preview.getByRole("textbox", { name: "Type 19 to confirm" })).toHaveValue("");
    await expect(preview.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
