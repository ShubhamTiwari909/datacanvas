/**
 * Editing cells in the grid, end to end (`docs/write-side-v2-plan.md`, section 5; milestone E4): a double click or
 * Enter opens an editor in the cell, Enter keeps the value as a pending change and Escape cancels; the pending cells
 * are marked and counted in a bar; the review lists them and goes through the usual preview; Apply writes them (no
 * tick). A row changed by another session since it was loaded is left out, and said so before anything is written.
 * Key, bytea and generated columns are not editable and say why. axe on the grid in edit mode, the bar and the review,
 * in light and dark.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";
import type { Locator, Page } from "@playwright/test";
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

/** axe on the elements a selector finds (each one checked), with the WCAG 2.1 A and AA rules. */
async function axeOn(page: Page, name: string, selector: string): Promise<void> {
  await settleForAxe(page);
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async (scope) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            c: { include: Element[] },
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
    return axe.run(
      { include: [...document.querySelectorAll(scope)] },
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } },
    );
  }, selector);
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
/** The cell of a row (by its position on the page, from 0) and a column (by its position, from 0). */
const cell = (page: Page, row: number, col: number): Locator =>
  grid(page).locator(`td[data-row="${row}"][data-col="${col}"]`);
const bar = (page: Page) => page.getByRole("group", { name: "Pending changes" });
const editor = (page: Page, column: string) =>
  grid(page).getByRole("textbox", { name: `New value of ${column}` });
// The columns of ec_items, in order.
const ID = 0;
const NAME = 1;
const QTY = 2;
const NOTE = 3;
const BLOB = 4;
const GEN = 5;

test.describe("editing cells in the grid", () => {
  test.beforeEach(async ({ page, writableApp, database }) => {
    await sql(
      database,
      `CREATE TABLE public.ec_items (
         id integer PRIMARY KEY,
         name text NOT NULL,
         qty integer CHECK (qty >= 0),
         note text,
         blob bytea,
         gen integer GENERATED ALWAYS AS (qty * 2) STORED
       );
       INSERT INTO public.ec_items (id, name, qty, note)
         SELECT i, 'n' || i, i, 'note' || i FROM generate_series(1, 30) i;`,
    );
    await page.goto(writableApp.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("Ec shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByLabel("Allow viewing table data").check();
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect Ec shop" })).toBeVisible();
    await page.getByRole("switch", { name: "Allow changes to Ec shop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
    await dialog.getByRole("button", { name: "Allow changes" }).click();
    await expect(page.getByText("Writes on")).toBeVisible();
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^ec_items\b/ })
      .first()
      .click();
    await expect(grid(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add row" })).toBeVisible();
  });

  test("edits two cells in two rows, then reviews, previews and applies them", async ({
    page,
    database,
  }) => {
    await expect(bar(page)).toHaveCount(0);
    await cell(page, 1, NAME).dblclick();
    await editor(page, "name").fill("bob");
    await editor(page, "name").press("Enter");
    await expect(editor(page, "name")).toHaveCount(0);
    await expect(cell(page, 1, NAME)).toHaveText("bob (changed)");
    await expect(bar(page).getByRole("status")).toHaveText("1 cell in 1 row changed");

    await cell(page, 2, QTY).dblclick();
    await editor(page, "qty").fill("33");
    await editor(page, "qty").press("Enter");
    await expect(cell(page, 2, QTY)).toHaveText("33 (changed)");
    await expect(bar(page).getByRole("status")).toHaveText("2 cells in 2 rows changed");
    // Nothing is written until the change is applied.
    expect(
      await sql(database, "SELECT name, qty FROM public.ec_items WHERE id IN (2, 3) ORDER BY id"),
    ).toEqual([
      { name: "n2", qty: 2 },
      { name: "n3", qty: 3 },
    ]);

    // The pending edits stay while paging.
    await page.getByRole("combobox", { name: "Rows per page" }).selectOption("25");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(cell(page, 0, ID)).toHaveText("26");
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(cell(page, 1, NAME)).toHaveText("bob (changed)");
    await expect(bar(page).getByRole("status")).toHaveText("2 cells in 2 rows changed");

    await bar(page).getByRole("button", { name: "Review" }).click();
    const review = page.getByRole("dialog", {
      name: "Review the changed cells of public.ec_items",
    });
    const reviewRows = review.getByRole("table").locator("tbody tr");
    await expect(reviewRows).toHaveCount(2);
    await expect(reviewRows.nth(0)).toContainText("id 2");
    await expect(reviewRows.nth(0)).toContainText("name");
    await expect(reviewRows.nth(0)).toContainText("n2");
    await expect(reviewRows.nth(0)).toContainText("bob");
    await expect(reviewRows.nth(1)).toContainText("id 3");
    await expect(reviewRows.nth(1)).toContainText("qty");
    await review.getByRole("button", { name: "Preview" }).click();

    const preview = page.getByRole("dialog", { name: "Edit 2 cells in 2 rows of public.ec_items" });
    await expect(preview.getByText(/^Changes 2 cells in 2 rows of /)).toBeVisible();
    await expect(
      preview.getByText(
        "Values are sent separately as $1, $2 and so on, never as part of the statement.",
      ),
    ).toBeVisible();
    // Not destructive: no tick, no count to type.
    await expect(preview.getByRole("checkbox")).toHaveCount(0);
    const apply = preview.getByRole("button", { name: "Apply" });
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(page.getByText("2 cells were changed.")).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    expect(
      await sql(
        database,
        "SELECT id, name, qty FROM public.ec_items WHERE id IN (2, 3) ORDER BY id",
      ),
    ).toEqual([
      { id: 2, name: "bob", qty: 2 },
      { id: 3, name: "n3", qty: 33 },
    ]);
    // The grid was read again: the values are the table's, not pending.
    await expect(cell(page, 1, NAME)).toHaveText("bob");
    await expect(cell(page, 2, QTY)).toHaveText("33");
  });

  test("Escape cancels, a value edited back is not pending, and undo and discard take changes back", async ({
    page,
    database,
  }) => {
    await cell(page, 0, NAME).dblclick();
    await editor(page, "name").fill("gone");
    await editor(page, "name").press("Escape");
    await expect(editor(page, "name")).toHaveCount(0);
    await expect(cell(page, 0, NAME)).toHaveText("n1");
    await expect(cell(page, 0, NAME)).toBeFocused();
    await expect(bar(page)).toHaveCount(0);

    // Changed, then changed back to what it was: nothing is pending.
    await cell(page, 0, NAME).dblclick();
    await editor(page, "name").fill("n1-x");
    await editor(page, "name").press("Enter");
    await expect(bar(page).getByRole("status")).toHaveText("1 cell in 1 row changed");
    await cell(page, 0, NAME).dblclick();
    await expect(editor(page, "name")).toHaveValue("n1-x");
    await editor(page, "name").fill("n1");
    await editor(page, "name").press("Enter");
    await expect(bar(page)).toHaveCount(0);
    await expect(cell(page, 0, NAME)).toHaveText("n1");

    // NULL apart from the empty string: NULL for note, kept with Ctrl+Enter from the button.
    await cell(page, 0, NOTE).dblclick();
    await grid(page).getByRole("button", { name: "NULL for note" }).click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(cell(page, 0, NOTE)).toHaveText("NULL (changed)");
    await cell(page, 1, NOTE).dblclick();
    await editor(page, "note").fill("");
    await editor(page, "note").press("Enter");
    await expect(cell(page, 1, NOTE)).toHaveText("(empty) (changed)");
    await expect(bar(page).getByRole("status")).toHaveText("2 cells in 2 rows changed");

    // Ctrl or Cmd plus Z in the grid takes the last step back; so does "Undo last".
    await cell(page, 1, NOTE).focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(cell(page, 1, NOTE)).toHaveText("note2");
    await expect(bar(page).getByRole("status")).toHaveText("1 cell in 1 row changed");
    await bar(page).getByRole("button", { name: "Undo last" }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect(cell(page, 0, NOTE)).toHaveText("note1");

    // Discard all.
    await cell(page, 3, NAME).dblclick();
    await editor(page, "name").fill("d");
    await editor(page, "name").press("Enter");
    await bar(page).getByRole("button", { name: "Discard all" }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect(cell(page, 3, NAME)).toHaveText("n4");

    // A filter is another view: pending edits are dropped with it.
    await cell(page, 4, NAME).dblclick();
    await editor(page, "name").fill("e");
    await editor(page, "name").press("Enter");
    await expect(bar(page)).toBeVisible();
    await page.getByRole("button", { name: /^Filter\b/ }).click();
    const panel = page.getByRole("form", { name: "Add a filter" });
    await panel.getByLabel("Column").selectOption("qty");
    await panel.getByLabel("Condition").selectOption({ label: "equals" });
    await panel.getByLabel("Value").fill("5");
    await panel.getByRole("button", { name: "Add filter" }).click();
    await expect(bar(page)).toHaveCount(0);
    expect(
      await sql(
        database,
        "SELECT count(*)::int AS n FROM public.ec_items WHERE name <> 'n' || id OR note IS DISTINCT FROM 'note' || id",
      ),
    ).toEqual([{ n: 0 }]);
  });

  test("the key column, bytea and a generated column are not editable, and say why", async ({
    page,
  }) => {
    await expect(cell(page, 0, ID)).toHaveAttribute(
      "title",
      /part of the key that finds the row, so it is not edited in the grid/,
    );
    await expect(cell(page, 0, BLOB)).toHaveAttribute(
      "title",
      "Values of this type cannot be edited here.",
    );
    await expect(cell(page, 0, GEN)).toHaveAttribute("title", "The database fills this column.");
    await expect(cell(page, 0, NAME)).not.toHaveAttribute("title", /.+/);

    // Enter on the key opens its value, not an editor.
    await cell(page, 0, ID).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog").getByLabel("Value of id", { exact: true })).toHaveText(
      "1",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(grid(page).getByRole("textbox")).toHaveCount(0);

    // Enter on bytea (NULL here) and on the generated column: no editor either.
    for (const col of [BLOB, GEN]) {
      await cell(page, 0, col).focus();
      await page.keyboard.press("Enter");
      await expect(grid(page).getByRole("textbox")).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await expect(bar(page)).toHaveCount(0);
  });

  test("a row changed by another session since it was loaded is left out, and one with every row changed is refused", async ({
    page,
    database,
  }) => {
    await cell(page, 0, NAME).dblclick();
    await editor(page, "name").fill("first");
    await editor(page, "name").press("Enter");
    await cell(page, 1, NAME).dblclick();
    await editor(page, "name").fill("second");
    await editor(page, "name").press("Enter");
    // Someone else changes row 2 after the page was read.
    await sql(database, "UPDATE public.ec_items SET name = 'someone-else' WHERE id = 2");

    await bar(page).getByRole("button", { name: "Review" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: "Edit 2 cells in 2 rows of public.ec_items" });
    await expect(preview.getByText(/^Changes 1 cell in 1 row of /)).toBeVisible();
    await expect(
      preview.getByRole("status").filter({ hasText: "1 row changed since you loaded it" }),
    ).toBeVisible();
    expect(
      await sql(database, "SELECT name FROM public.ec_items WHERE id IN (1, 2) ORDER BY id"),
    ).toEqual([{ name: "n1" }, { name: "someone-else" }]);
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("1 cell was changed.")).toBeVisible();
    expect(
      await sql(database, "SELECT name FROM public.ec_items WHERE id IN (1, 2) ORDER BY id"),
    ).toEqual([{ name: "first" }, { name: "someone-else" }]);
    await expect(bar(page)).toHaveCount(0);

    // Every row changed since: the preview refuses, nothing is written, and the edit stays pending.
    await cell(page, 2, QTY).dblclick();
    await editor(page, "qty").fill("7");
    await editor(page, "qty").press("Enter");
    await sql(database, "UPDATE public.ec_items SET qty = 99 WHERE id = 3");
    await bar(page).getByRole("button", { name: "Review" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Preview" }).click();
    const refused = page.getByRole("dialog", { name: "Edit 1 cell in 1 row of public.ec_items" });
    await expect(refused.getByRole("alert")).toContainText("This change cannot be made");
    await expect(refused.getByRole("alert")).toContainText(
      "was changed or deleted since you loaded it",
    );
    await refused.getByRole("button", { name: "Close" }).first().click();
    await expect(bar(page).getByRole("status")).toHaveText("1 cell in 1 row changed");
    expect(await sql(database, "SELECT qty FROM public.ec_items WHERE id = 3")).toEqual([
      { qty: 99 },
    ]);
  });

  test("works with the keyboard alone", async ({ page, database }) => {
    await cell(page, 0, NAME).focus();
    await page.keyboard.press("ArrowDown");
    await expect(cell(page, 1, NAME)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor(page, "name")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("typed");
    await page.keyboard.press("Enter");
    await expect(cell(page, 1, NAME)).toBeFocused();
    await expect(cell(page, 1, NAME)).toHaveText("typed (changed)");
    // The arrow keys move between cells again.
    await page.keyboard.press("ArrowRight");
    await expect(cell(page, 1, QTY)).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("12");
    // Inside the editor the arrow keys move the caret, not the cell.
    await page.keyboard.press("ArrowLeft");
    await expect(editor(page, "qty")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(bar(page).getByRole("status")).toHaveText("2 cells in 1 row changed");

    // To the bar with Tab and Shift+Tab is a long way; focus moves there as a keyboard user would land on it.
    await bar(page).getByRole("button", { name: "Review" }).focus();
    await page.keyboard.press("Enter");
    const review = page.getByRole("dialog", {
      name: "Review the changed cells of public.ec_items",
    });
    await expect(review).toBeVisible();
    // Focus starts on Preview, so Enter never takes a change back by surprise.
    await expect(review.getByRole("button", { name: "Preview" })).toBeFocused();
    // Take the qty change back from the review, with the keyboard.
    await review.getByRole("button", { name: "Take back the change to qty in id 2" }).focus();
    await page.keyboard.press("Enter");
    await expect(review.getByRole("table").locator("tbody tr")).toHaveCount(1);
    await review.getByRole("button", { name: "Preview" }).focus();
    await page.keyboard.press("Enter");
    const preview = page.getByRole("dialog", { name: "Edit 1 cell in 1 row of public.ec_items" });
    const apply = preview.getByRole("button", { name: "Apply" });
    await expect(apply).toBeEnabled();
    await apply.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("1 cell was changed.")).toBeVisible();
    expect(await sql(database, "SELECT name, qty FROM public.ec_items WHERE id = 2")).toEqual([
      { name: "typed", qty: 2 },
    ]);
  });

  test("passes axe in light and dark: the grid in edit mode, the bar and the review", async ({
    page,
  }) => {
    await cell(page, 0, NAME).dblclick();
    await editor(page, "name").fill("x");
    await editor(page, "name").press("Enter");
    // One cell pending and one being edited.
    await cell(page, 1, NOTE).dblclick();
    await expect(editor(page, "note")).toBeVisible();
    for (const theme of ["Light", "Dark"] as const) {
      if (theme === "Dark") {
        await editor(page, "note").press("Escape");
        await page.getByRole("button", { name: /^Theme:/ }).click();
        await page.getByRole("menuitemradio", { name: "Dark" }).click();
        await expect(page.getByRole("menu")).toHaveCount(0);
        await cell(page, 1, NOTE).dblclick();
        await expect(editor(page, "note")).toBeVisible();
      }
      await axeOn(page, `the grid in edit mode (${theme})`, '[role="grid"]');
      await axeOn(page, `the bar of pending changes (${theme})`, '[aria-label="Pending changes"]');
      await editor(page, "note").press("Escape");
      await bar(page).getByRole("button", { name: "Review" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await axeOn(page, `the review (${theme})`, '[role="dialog"]');
      await page.getByRole("dialog").getByRole("button", { name: "Preview" }).click();
      await expect(page.getByRole("dialog").getByRole("button", { name: "Apply" })).toBeEnabled();
      await axeOn(page, `the preview of the edit (${theme})`, '[role="dialog"]');
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await cell(page, 1, NOTE).dblclick();
      await expect(editor(page, "note")).toBeVisible();
    }
  });
});
