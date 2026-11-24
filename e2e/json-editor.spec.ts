/**
 * The JSON editor, end to end (1.8.0, D2): a JSON cell opened as JSON (the whole value, though the grid
 * cuts a cell short), the tree, Format and Minify that keep a large number's digits, the place of an
 * error, editing in a form with the changes shown and then previewed and applied, a value too long for
 * a page read whole and edited, and axe in both themes and on a phone.
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

function client(database: TestDb): pg.Client {
  return new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
}
async function sql<Row extends Record<string, unknown> = Record<string, unknown>>(
  database: TestDb,
  text: string,
): Promise<Row[]> {
  const c = client(database);
  await c.connect();
  try {
    return (await c.query(text)).rows as Row[];
  } finally {
    await c.end();
  }
}

async function plant(database: TestDb): Promise<void> {
  await sql(
    database,
    `CREATE TABLE public.j_docs (id integer PRIMARY KEY, doc jsonb, raw json);
     INSERT INTO public.j_docs VALUES
       (1, '{"name": "ann", "n": 12345678901234567890, "tags": ["x", "y"], "deep": {"a": {"b": 1}}}', '{"k":   1}'),
       (2, NULL, NULL),
       (3, jsonb_build_object('items', (SELECT jsonb_agg('item-' || i || '-' || repeat('z', 40)) FROM generate_series(1, 120) i)), NULL);`,
  );
}

async function connect(page: Page, link: string, database: TestDb): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("J shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect J shop" })).toBeVisible();
}

async function unlock(page: Page, database: TestDb): Promise<void> {
  await page.getByRole("switch", { name: "Allow changes to J shop" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
  await dialog.getByRole("button", { name: "Allow changes" }).click();
  await expect(page.getByText("Writes on")).toBeVisible();
}

async function openTable(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Table details" }).click();
  await page
    .getByRole("button", { name: /^j_docs\b/ })
    .first()
    .click();
  await expect(page.getByRole("grid")).toBeVisible();
}

async function axeOn(page: Page, name: string): Promise<void> {
  await settleForAxe(page);
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
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
    return axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });
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

const jsonDialog = (page: Page) => page.getByRole("dialog", { name: /as JSON$/ });
const editorText = (page: Page) => page.locator(".monaco-editor .view-lines").first();

/** Replace everything in the editor with this text (typed as one insertion, so brackets are not auto-closed). */
async function setEditorText(page: Page, text: string): Promise<void> {
  await editorText(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  // Typing over a selection would wrap it in the brackets typed (a surrounding pair): remove it first.
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

test.describe("viewing a JSON value", () => {
  test.beforeEach(async ({ page, app, database }) => {
    await plant(database);
    await connect(page, app.link, database);
    await openTable(page);
  });

  test("a JSON cell opens as JSON: the tree, a path to copy, and the whole value of a long one", async ({
    page,
  }) => {
    // Row 1: a short document, complete in the grid.
    await page
      .getByRole("grid")
      .getByRole("gridcell", { name: /"name": "ann"/ })
      .click();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Open as JSON" }).click();
    const dialog = jsonDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Valid JSON, \d+ characters/)).toBeVisible();
    // Read only: nothing to apply, only Close.
    await expect(dialog.getByRole("button", { name: "Use this value" })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Tree" }).click();
    const tree = dialog.getByLabel("Tree of the document");
    // The large number keeps its digits.
    await tree.getByRole("button", { name: /^deep/ }).first().waitFor();
    await expect(tree).toContainText("12345678901234567890");
    // The first two levels start open, deeper ones closed.
    await expect(tree.getByRole("button", { name: "Collapse deep" })).toBeVisible();
    await tree.getByRole("button", { name: "Expand a", exact: true }).click();
    await tree.getByRole("button", { name: /^b: 1$/ }).click();
    await expect(dialog.getByText("$.deep.a.b")).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog).toHaveCount(0);
  });

  test("a document longer than a grid cell is read whole", async ({ page }) => {
    // Row 3 is about 6,000 characters: the grid and the cell dialog show the first 2,000.
    const cells = page.getByRole("grid").getByRole("gridcell", { name: /item-1-/ });
    await cells.first().click();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/longer than 2,000 characters/)).toBeVisible();
    await page.getByRole("button", { name: "Open as JSON" }).click();
    const dialog = jsonDialog(page);
    await expect(dialog.getByText(/Valid JSON, [\d,]+ characters/)).toBeVisible();
    const status = await dialog.getByRole("status").last().innerText();
    const count = Number(/([\d,]+) characters/.exec(status)![1]!.replace(/,/g, ""));
    expect(count).toBeGreaterThan(5000);
    await dialog.getByRole("button", { name: "Tree" }).click();
    await expect(dialog.getByLabel("Tree of the document")).toContainText("120 items");
  });

  test("passes axe in light, in dark, and on a phone", async ({ page }) => {
    const openJson = async () => {
      await page
        .getByRole("grid")
        .getByRole("gridcell", { name: /"name": "ann"/ })
        .click();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Open as JSON" }).click();
      await expect(jsonDialog(page).getByText(/Valid JSON/)).toBeVisible();
    };
    const leave = async () => {
      await jsonDialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
      await expect(jsonDialog(page)).toHaveCount(0);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .first()
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    };
    for (const theme of ["Light", "Dark"] as const) {
      await page.getByRole("button", { name: /^Theme:/ }).click();
      await page.getByRole("menuitemradio", { name: theme }).click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await openJson();
      await axeOn(page, `the JSON editor (${theme.toLowerCase()})`);
      await jsonDialog(page).getByRole("button", { name: "Tree" }).click();
      await axeOn(page, `the JSON tree (${theme.toLowerCase()})`);
      await leave();
    }
    await page.setViewportSize({ width: 390, height: 800 });
    await openJson();
    await axeOn(page, "the JSON editor (phone)");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("editing a JSON value", () => {
  test.beforeEach(async ({ page, writableApp, database }) => {
    await plant(database);
    await connect(page, writableApp.link, database);
    await unlock(page, database);
    await openTable(page);
  });

  test("shows where it stops being JSON, formats without changing a digit, and saves through the preview", async ({
    page,
    database,
  }) => {
    await page.getByRole("button", { name: "Edit row 1" }).click();
    const form = page.getByRole("dialog", { name: /Edit a row of/ });
    await form.getByRole("button", { name: "Edit doc as JSON" }).click();
    const dialog = jsonDialog(page);
    await expect(dialog.getByText(/Valid JSON/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Use this value" })).toBeDisabled();

    // Not JSON: the position is named, and the document cannot be used.
    await setEditorText(page, '{"a": 1, "b": }');
    await expect(dialog.getByRole("status").last()).toContainText(/Line 1, column 15:/);
    await expect(dialog.getByRole("button", { name: "Format" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Use this value" })).toBeDisabled();
    await expect(page.locator(".monaco-editor .squiggly-error").first()).toBeVisible();

    // A valid document with a number a double would change: Minify and Format keep every digit.
    await setEditorText(
      page,
      '{ "n": 12345678901234567890, "d": 0.10000000000000000001, "e": [ ] }',
    );
    await dialog.getByRole("button", { name: "Minify" }).click();
    await expect(editorText(page)).toContainText(
      '{"n":12345678901234567890,"d":0.10000000000000000001,"e":[]}',
    );
    await dialog.getByRole("button", { name: "Format" }).click();
    await expect(editorText(page)).toContainText("12345678901234567890");
    await expect(editorText(page)).toContainText("0.10000000000000000001");

    // The Changes view compares with what was loaded.
    await dialog.getByRole("button", { name: /^Changes/ }).click();
    await expect(dialog.getByLabel("Changes against the loaded value")).toContainText('"tags"');
    await dialog.getByRole("button", { name: "Use this value" }).click();
    await expect(dialog).toHaveCount(0);

    // Back in the form: preview and apply like any value.
    await form.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog");
    await expect(preview.getByLabel("The statement that will run")).toContainText(
      'UPDATE "public"."j_docs"',
    );
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("The row was changed.")).toBeVisible();
    const rows = await sql<{ doc: unknown; text: string }>(
      database,
      "SELECT doc, doc::text AS text FROM public.j_docs WHERE id = 1",
    );
    expect(rows[0]!.text).toContain("12345678901234567890");
    expect(rows[0]!.text).toContain("0.10000000000000000001");
  });

  test("a value too long for a page is read whole in the editor, and saved", async ({
    page,
    database,
  }) => {
    await page.getByRole("button", { name: "Edit row 3" }).click();
    const form = page.getByRole("dialog", { name: /Edit a row of/ });
    await expect(form.getByText(/Only part of this value was read/)).toBeVisible();
    await form.getByRole("button", { name: "Read it whole in the JSON editor" }).click();
    const dialog = jsonDialog(page);
    await expect(dialog.getByText(/Valid JSON, [\d,]+ characters/)).toBeVisible();
    await setEditorText(page, '{"items": ["replaced"]}');
    await dialog.getByRole("button", { name: "Use this value" }).click();
    await expect(dialog).toHaveCount(0);

    await form.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog");
    await preview.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("The row was changed.")).toBeVisible();
    expect(await sql(database, "SELECT doc FROM public.j_docs WHERE id = 3")).toEqual([
      { doc: { items: ["replaced"] } },
    ]);
  });

  test("adding a row can use the editor, and NULL stays available", async ({ page, database }) => {
    await page.getByRole("button", { name: "Add row" }).click();
    const form = page.getByRole("dialog", { name: /Add a row to/ });
    await form.getByRole("textbox", { name: "Value for id" }).fill("9");
    await form.getByRole("button", { name: "Edit doc as JSON" }).click();
    await setEditorText(page, '{"fresh": true}');
    await jsonDialog(page).getByRole("button", { name: "Use this value" }).click();
    await form.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("The row was added.")).toBeVisible();
    expect(await sql(database, "SELECT doc FROM public.j_docs WHERE id = 9")).toEqual([
      { doc: { fresh: true } },
    ]);
  });
});
