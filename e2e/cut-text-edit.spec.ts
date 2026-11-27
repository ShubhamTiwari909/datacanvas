/**
 * Editing a text value that the grid cut short, end to end (`docs/write-side-v2-plan.md`, section 7; milestone E5a):
 * the cell's dialog reads the WHOLE value and offers Edit only when the server says the whole value can be edited
 * (at most 100,000 characters); the change is kept as a pending cell checked against the whole value (a change in
 * the part the grid did not show leaves the row out), reviewed, previewed and applied. A value that is too long to
 * edit is shown for reading and copying with the reason; one over a million characters says it is not read here.
 * Key and short cells are as before. axe on the dialogs, in light and dark.
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
const cell = (page: Page, row: number, col: number): Locator =>
  grid(page).locator(`td[data-row="${row}"][data-col="${col}"]`);
const bar = (page: Page) => page.getByRole("group", { name: "Pending changes" });
// The columns of ct_notes, in order.
const TITLE = 1;
const BODY = 2;
// The rows, in order of id.
const SHORT = 0; // a body of a few characters
const CUT = 1; // 5,002 characters
const LIMIT = 2; // exactly 100,000 characters
const LONG = 3; // 100,001 characters
const HUGE = 4; // 1,000,001 characters
const CRLF = 5; // 2,100 characters with a Windows line ending inside
const SHORT_CRLF = 6;

const cellDialog = (page: Page, column = "body") =>
  page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: column, exact: true }) });
const editDialog = (page: Page) => page.getByRole("dialog", { name: /^Edit body$/ });
/**
 * After the window of the whole value is closed, closes the value's own window with Escape: once the first has finished
 * leaving (it is still in the page while it fades out, and keys are not for it then).
 */
async function closeCellDialog(page: Page): Promise<void> {
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
}
const wholeField = (page: Page) => page.getByRole("textbox", { name: "New value of body" });

test.describe("editing a cut text value", () => {
  test.beforeEach(async ({ page, writableApp, database }) => {
    await sql(
      database,
      `CREATE TABLE public.ct_notes (id integer PRIMARY KEY, title text, body text);
       INSERT INTO public.ct_notes VALUES
         (1, 'short', 'a short body'),
         (2, 'cut', 'START-' || repeat('lorem ipsum ', 416) || '-END'),
         (3, 'limit', repeat('a', 100000)),
         (4, 'long', repeat('b', 100001)),
         (5, 'huge', repeat('c', 1000001)),
         (6, 'crlf', 'first' || chr(13) || chr(10) || 'second' || repeat('d', 2100)),
         (7, 'short crlf', 'first' || chr(13) || chr(10) || 'second');`,
    );
    await page.goto(writableApp.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("Ct shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByLabel("Allow viewing table data").check();
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect Ct shop" })).toBeVisible();
    await page.getByRole("switch", { name: "Allow changes to Ct shop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
    await dialog.getByRole("button", { name: "Allow changes" }).click();
    await expect(page.getByText("Writes on")).toBeVisible();
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^ct_notes\b/ })
      .first()
      .click();
    await expect(grid(page)).toBeVisible();
  });

  test("reads the whole value, edits it, and reviews, previews and applies the change", async ({
    page,
    database,
  }) => {
    // The grid holds only the start; a click opens the value, which offers Edit.
    await cell(page, CUT, BODY).click();
    const opened = cellDialog(page);
    await expect(opened.getByText("longer than 2,000 characters")).toBeVisible();
    await opened.getByRole("button", { name: "Edit this value" }).click();

    const editing = editDialog(page);
    const field = wholeField(page);
    await expect(field).toBeVisible();
    // The whole value, from the database: its end is there, though the page cut it at 2,000 characters.
    await expect(field).toHaveValue(/^START-lorem ipsum .*lorem ipsum -END$/);
    await expect(editing.getByRole("status")).toHaveText("5,002 characters.");
    await expect(editing.getByRole("button", { name: "Use this value" })).toBeDisabled();

    // Change the part the grid never showed.
    await field.fill((await field.inputValue()).replace("-END", "-THE END"));
    await expect(editing.getByRole("status")).toHaveText("5,006 characters.");
    await editing.getByRole("button", { name: "Use this value" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect(bar(page).getByRole("status")).toHaveText("1 cell in 1 row changed");
    await expect(cell(page, CUT, BODY)).toContainText("(changed)");
    // Nothing is written until the change is applied.
    expect(
      await sql(database, "SELECT right(body, 4) AS tail FROM public.ct_notes WHERE id = 2"),
    ).toEqual([{ tail: "-END" }]);

    // The dialog of a pending cell shows the new value and starts the editor from it.
    await cell(page, CUT, BODY).click();
    await expect(cellDialog(page).getByText("not saved yet")).toBeVisible();
    await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
    await expect(wholeField(page)).toHaveValue(/-THE END$/);
    await editDialog(page).getByRole("button", { name: "Cancel" }).click();
    await closeCellDialog(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await bar(page).getByRole("button", { name: "Review" }).click();
    const review = page.getByRole("dialog", {
      name: "Review the changed cells of public.ct_notes",
    });
    await expect(review.getByRole("table").locator("tbody tr")).toHaveCount(1);
    await review.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: "Edit 1 cell in 1 row of public.ct_notes" });
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("1 cell was changed.")).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    expect(
      await sql(
        database,
        "SELECT length(body) AS n, right(body, 8) AS tail, left(body, 6) AS head FROM public.ct_notes WHERE id = 2",
      ),
    ).toEqual([{ n: 5006, tail: "-THE END", head: "START-" }]);
  });

  test("is checked against the whole value: a change made later to the part the grid did not show leaves the row out", async ({
    page,
    database,
  }) => {
    await cell(page, CUT, BODY).click();
    await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
    await wholeField(page).fill("replaced entirely");
    await editDialog(page).getByRole("button", { name: "Use this value" }).click();
    await expect(bar(page).getByRole("status")).toHaveText("1 cell in 1 row changed");

    // Another session changes the end of the value: the start, which the grid showed, is the same.
    await sql(
      database,
      "UPDATE public.ct_notes SET body = left(body, length(body) - 4) || '-BYE' WHERE id = 2",
    );
    await bar(page).getByRole("button", { name: "Review" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Preview" }).click();
    const refused = page.getByRole("dialog", { name: "Edit 1 cell in 1 row of public.ct_notes" });
    await expect(refused.getByRole("alert")).toContainText(
      "was changed or deleted since you loaded it",
    );
    expect(
      await sql(database, "SELECT right(body, 4) AS tail FROM public.ct_notes WHERE id = 2"),
    ).toEqual([{ tail: "-BYE" }]);
  });

  test("offers Edit at exactly 100,000 characters, and reads but does not edit a longer value, saying why", async ({
    page,
  }) => {
    await cell(page, LIMIT, BODY).click();
    await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
    await expect(editDialog(page).getByRole("status")).toHaveText("100,000 characters.");
    await expect(wholeField(page)).toBeEditable();
    await editDialog(page).getByRole("button", { name: "Cancel" }).click();
    await closeCellDialog(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Typing past the limit is refused in the editor.
    await cell(page, LIMIT, BODY).click();
    await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
    await wholeField(page).press("End");
    await page.keyboard.type("z");
    await expect(editDialog(page).getByRole("status")).toContainText(
      "longer than 100,000 characters, which is the most a change can carry",
    );
    await expect(editDialog(page).getByRole("button", { name: "Use this value" })).toBeDisabled();
    await editDialog(page).getByRole("button", { name: "Cancel" }).click();
    await closeCellDialog(page);

    // 100,001: read and copied, not edited, and the dialog says why.
    await cell(page, LONG, BODY).click();
    await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
    const reading = page.getByRole("dialog", { name: /^Edit body$/ });
    await expect(reading.getByRole("status")).toContainText(
      "This value is 100,001 characters long.",
    );
    await expect(reading.getByRole("status")).toContainText(
      "longer than 100,000 characters, which is the most a change can carry, so it can be read and copied here but not edited.",
    );
    await expect(wholeField(page)).toHaveCount(0);
    await expect(reading.getByRole("button", { name: "Use this value" })).toHaveCount(0);
    await expect(
      reading.getByRole("button", { name: /^Copy the whole value of body/ }),
    ).toBeVisible();
    await expect(reading.getByLabel("Whole value of body", { exact: true })).toBeVisible();
    await reading.getByRole("button", { name: "Close" }).first().click();
    await closeCellDialog(page);
    await expect(bar(page)).toHaveCount(0);
  });

  test("does not edit a value with Windows line endings, which a text field would rewrite, and says why", async ({
    page,
    database,
  }) => {
    await cell(page, CRLF, BODY).click();
    await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
    const dialog = page.getByRole("dialog", { name: /^Edit body$/ });
    await expect(dialog.getByRole("status")).toHaveText(
      "This value has Windows line endings (or a bare carriage return), which this editor cannot keep exactly.",
    );
    await expect(wholeField(page)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Use this value" })).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    expect(
      await sql(
        database,
        "SELECT position(chr(13) in body) AS at FROM public.ct_notes WHERE id = 6",
      ),
    ).toEqual([{ at: 6 }]);
  });

  test("keeps a short value with Windows line endings read-only", async ({ page }) => {
    const body = cell(page, SHORT_CRLF, BODY);
    await expect(body).toHaveAttribute("title", /Windows line endings/);
    await body.dblclick();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(wholeField(page)).toHaveCount(0);
    await expect(page.getByRole("dialog").getByText(/Windows line endings/)).toBeVisible();
  });

  test("says a value over a million characters is not read here, and offers no edit", async ({
    page,
  }) => {
    await cell(page, HUGE, BODY).click();
    await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
    const dialog = page.getByRole("dialog", { name: /^Edit body$/ });
    await expect(dialog.getByRole("status")).toHaveText(
      "This value is longer than 1 million characters, so it is not read here and cannot be edited. Use the SQL tab to look at parts of it.",
    );
    await expect(wholeField(page)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Use this value" })).toHaveCount(0);
  });

  test("a short cell is edited in place as before, and a cut cell is not edited in place", async ({
    page,
  }) => {
    await cell(page, SHORT, BODY).dblclick();
    await expect(grid(page).getByRole("textbox", { name: "New value of body" })).toBeVisible();
    await grid(page).getByRole("textbox", { name: "New value of body" }).press("Escape");
    // A double click on a cut cell opens no in-place editor (the row's form opens, as for any cell that is not edited
    // in place); its tooltip says that the value's window edits it.
    await expect(cell(page, CUT, BODY)).toHaveAttribute("title", /Open it to edit the whole value/);
    await cell(page, CUT, BODY).dblclick();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(grid(page).getByRole("textbox", { name: "New value of body" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cell(page, SHORT, TITLE)).toHaveText("short");
  });

  test("passes axe in light and dark: the editor, a value too long to edit, and one too large", async ({
    page,
  }) => {
    for (const theme of ["Light", "Dark"] as const) {
      if (theme === "Dark") {
        await page.getByRole("button", { name: /^Theme:/ }).click();
        await page.getByRole("menuitemradio", { name: "Dark" }).click();
        await expect(page.getByRole("menu")).toHaveCount(0);
      }
      for (const [row, name] of [
        [CUT, "the editor"],
        [LONG, "a value too long to edit"],
        [HUGE, "a value too large to read"],
      ] as const) {
        await cell(page, row, BODY).click();
        await cellDialog(page).getByRole("button", { name: "Edit this value" }).click();
        await expect(page.getByRole("dialog", { name: /^Edit body$/ })).toBeVisible();
        await expect(page.getByText("Reading the whole value…")).toHaveCount(0);
        await axeOn(page, `${name} (${theme})`, '[role="dialog"]');
        await page.keyboard.press("Escape");
        await closeCellDialog(page);
      }
    }
  });
});
