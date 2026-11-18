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
  await designRules(page, name);

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

/** The widths a data-changing dialog may have (docs/ui-polish-plan.md, U1): confirm, form, builder. */
const WIDTH: Record<string, number> = {
  unlock: 448,
  "edit-row": 640,
  preview: 640,
  "add-row": 640,
  "new-table": 768,
  "edit-structure": 640,
  history: 640,
};

/** The U1 rules: one of three widths, no text under 11 px, and the footer inside the window. */
async function designRules(page: Page, name: string): Promise<void> {
  const m = await page.evaluate(() => {
    const dialog = document.querySelector("[role=dialog]");
    if (!dialog) throw new Error("no dialog");
    const small: string[] = [];
    for (const el of dialog.querySelectorAll("*")) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!hasText) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 11)
        small.push(
          `${el.tagName.toLowerCase()} ${size}px "${el.textContent?.trim().slice(0, 20)}"`,
        );
    }
    const footer = dialog.querySelector("[data-slot=dialog-footer]")?.getBoundingClientRect();
    const frame = dialog.getBoundingClientRect();
    return {
      footerGap: footer ? Math.round(frame.bottom - footer.bottom) : null,
      width: Math.round(dialog.getBoundingClientRect().width),
      small,
      footerBottom: footer ? Math.round(footer.bottom) : null,
      innerHeight: window.innerHeight,
    };
  });
  expect.soft(m.width, `${name}: width`).toBe(WIDTH[name]);
  expect.soft(m.small, `${name}: text under 11px`).toEqual([]);
  if (m.footerGap !== null) {
    // Flush with the dialog's bottom edge: no strip of scrolled content under the footer.
    expect
      .soft(m.footerGap, `${name}: footer flush with the dialog's bottom`)
      .toBeLessThanOrEqual(1);
  }
  if (m.footerBottom !== null) {
    expect
      .soft(m.footerBottom, `${name}: footer inside the window`)
      .toBeLessThanOrEqual(m.innerHeight);
  }
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

test("a tall form scrolls its body and keeps the footer in view", async ({
  page,
  writableApp,
  database,
}) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await plant(database);
  await connect(page, writableApp.link, database);
  await page.getByRole("switch", { name: "Allow changes to UI shop" }).click();
  await page.getByRole("textbox", { name: "Database name" }).fill(database.name);
  await page.getByRole("button", { name: "Allow changes" }).click();
  await expect(page.getByText("Writes on")).toBeVisible();

  await page.getByRole("button", { name: "New table in public" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Table name" }).fill("ui_tall");
  for (let column = 2; column <= 5; column += 1) {
    await dialog.getByRole("button", { name: "Add a column" }).click();
    await dialog.getByLabel(`Column ${column} name`).fill(`c${column}`);
  }

  // The dialog stays inside the window and its content scrolls...
  const box = await dialog.boundingBox();
  expect(box && box.y >= 0 && box.y + box.height <= 560, "the dialog fits the window").toBe(true);
  const scrolls = await dialog.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls, "the content scrolls").toBe(true);
  // ...while Preview stays reachable without scrolling.
  await expect(dialog.getByRole("button", { name: "Preview" })).toBeInViewport({ ratio: 1 });
});
