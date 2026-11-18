/**
 * The look of every form and dialog that changes data (docs/ui-polish-plan.md, U0).
 *
 * One test per theme walks through the nine screens: the unlock dialog, the
 * row editor, its preview, the add-row form, the new-table builder (with three
 * columns, so it is tall), the structure editor, and the session history. On
 * each it
 *   - saves a screenshot of the dialog (to UI_FORMS_DIR, default
 *     test-results/ui-forms; run once before a UI change and once after, with
 *     two directories, to compare), and
 *   - runs axe-core on the dialog (WCAG 2.0 and 2.1, levels A and AA) and
 *     fails on any violation (reported for every screen in one run).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.UI_FORMS_DIR ?? path.join(here, "../test-results/ui-forms");
const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

interface AxeResult {
  violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: unknown[] }> }>;
}

async function plant(database: TestDb): Promise<void> {
  const client = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE public.ui_people (
        id integer PRIMARY KEY,
        name text NOT NULL,
        note text,
        active boolean NOT NULL DEFAULT true,
        joined timestamptz NOT NULL DEFAULT now(),
        profile jsonb
      );
      INSERT INTO public.ui_people (id, name, note, profile) VALUES
        (1, 'Ada Lovelace', 'first', '{"role": "analyst"}'),
        (2, 'Grace Hopper', NULL, NULL);
    `);
  } finally {
    await client.end();
  }
}

async function connect(page: Page, link: string, database: TestDb): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("UI shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect UI shop" })).toBeVisible();
}

/** Screenshot the open dialog and run axe on it; the name is the file name. */
async function inspect(page: Page, name: string, theme: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350); // the open animation
  mkdirSync(shots, { recursive: true });
  await dialog.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });

  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (c: Element, o: object) => Promise<AxeResult> } }
    ).axe;
    const root = document.querySelector("[role=dialog]");
    if (!root) throw new Error("no dialog");
    return axe.run(root, {
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
  // Soft, so one run reports every violation and saves every screenshot.
  expect.soft(found, `axe on ${name} (${theme})`).toEqual([]);
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

for (const theme of ["light", "dark"] as const) {
  test(`every form and dialog, ${theme} theme`, async ({ page, writableApp, database }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: theme });
    await plant(database);
    await connect(page, writableApp.link, database);

    // --- unlock
    await page.getByRole("switch", { name: "Allow changes to UI shop" }).click();
    await inspect(page, "unlock", theme);
    await page.getByRole("textbox", { name: "Database name" }).fill(database.name);
    await page.getByRole("button", { name: "Allow changes" }).click();
    await expect(page.getByText("Writes on")).toBeVisible();

    // --- the Data section of a table
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^ui_people\b/ })
      .first()
      .click();
    await expect(page.getByRole("grid")).toBeVisible();

    // --- row editor, then its preview
    await page.getByRole("button", { name: "Edit row 1" }).click();
    await inspect(page, "edit-row", theme);
    await page.getByRole("textbox", { name: "name", exact: true }).fill("Ada King");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByLabel("The statement that will run")).toBeVisible();
    await inspect(page, "preview", theme);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("The row was changed.")).toBeVisible();

    // --- add row
    await page.getByRole("button", { name: "Add row" }).click();
    await inspect(page, "add-row", theme);
    await closeDialog(page);

    // --- new table, with three columns so the form is tall
    await page.getByRole("button", { name: "New table in public" }).click();
    const create = page.getByRole("dialog");
    await create.getByRole("textbox", { name: "Table name" }).fill("ui_made");
    await create.getByRole("button", { name: "Add a column" }).click();
    await create.getByLabel("Column 2 name").fill("label");
    await create.getByRole("button", { name: "Add a column" }).click();
    await create.getByLabel("Column 3 name").fill("amount");
    await inspect(page, "new-table", theme);
    await closeDialog(page);

    // --- structure editor
    await page.getByRole("button", { name: "Edit structure" }).click();
    await inspect(page, "edit-structure", theme);
    await closeDialog(page);

    // --- session history (there is one change to list)
    await page.getByRole("button", { name: "Changes made to UI shop in this session" }).click();
    await inspect(page, "history", theme);
    await closeDialog(page);
  });
}
