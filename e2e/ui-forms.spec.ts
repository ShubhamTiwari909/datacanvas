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
import type { Locator, Page } from "@playwright/test";
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

async function connect(page: Page, link: string, database: TestDb, phone = false): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("UI shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  // On a phone the sidebar is a drawer, so connecting is confirmed by the dialog closing.
  if (phone) await expect(page.getByRole("dialog")).toHaveCount(0);
  else await expect(page.getByRole("button", { name: "Disconnect UI shop" })).toBeVisible();
}

/** Screenshot the open dialog and run axe on it; the name is the file name. */
async function inspect(page: Page, name: string, theme: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350); // the open animation
  mkdirSync(shots, { recursive: true });
  // A dialog that scrolls is shown from the top and again from the bottom.
  await dialog.evaluate((el) => el.scrollTo({ top: 0 }));
  await dialog.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
  if (await dialog.evaluate((el) => el.scrollHeight > el.clientHeight + 1)) {
    await dialog.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await dialog.screenshot({ path: path.join(shots, `${name}-${theme}-end.png`) });
    await dialog.evaluate((el) => el.scrollTo({ top: 0 }));
  }
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

/** U2: the row forms use the control that fits the value, with one rhythm (docs/ui-polish-plan.md). */
async function editRowRules(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  // No native radios or checkboxes (the switch's own hidden one is not counted): NULL, Default and Reset are buttons beside the field.
  expect(
    await dialog
      .locator("input[type=radio]:not([aria-hidden]), input[type=checkbox]:not([aria-hidden])")
      .count(),
    "edit-row: no radios or checkboxes",
  ).toBe(0);
  // A boolean is a switch; a number, a date and text are fields.
  await expect(dialog.getByRole("switch", { name: "active" })).toBeVisible();
  // Focus starts on the first column that is not part of the key, not on the key.
  const focused = await page.evaluate(
    () =>
      document.activeElement?.closest("[data-slot=form-field]")?.querySelector("label")
        ?.textContent,
  );
  expect(focused, "edit-row: first focus").toBe("name");
  // One rhythm: every field is the same distance from the next.
  const tops = await dialog
    .locator("[data-slot=form-field]")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  const pitches = tops.slice(1).map((top, i) => top - (tops[i] ?? 0));
  expect(new Set(pitches).size, `edit-row: one pitch, got ${pitches.join(", ")}`).toBe(1);
  // Preview says why it waits, then how many columns changed.
  await expect(dialog.getByRole("status")).toContainText("No changes yet");
  await expect(dialog.getByRole("button", { name: "Preview" })).toBeDisabled();
  // A changed field says so and can be put back; the count follows.
  await dialog.getByRole("textbox", { name: "name", exact: true }).fill("Someone Else");
  await expect(dialog.getByText("Changed", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("1 column changed");
  await dialog.getByRole("button", { name: "Reset name" }).click();
  await expect(dialog.getByText("Changed", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText("No changes yet");
}

async function addRowRules(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  expect(
    await dialog
      .locator("input[type=radio]:not([aria-hidden]), input[type=checkbox]:not([aria-hidden])")
      .count(),
    "add-row: no radios or checkboxes",
  ).toBe(0);
  // Nothing is an error before anyone has typed.
  await expect(dialog.getByText(/This column takes/)).toHaveCount(0);
  // A required column with no default shows just its field: there is no choice to make.
  await expect(dialog.getByRole("textbox", { name: "Value for name" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "NULL for name" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Default for name" })).toHaveCount(0);
  // A nullable column offers both, and Default is where it starts.
  await expect(dialog.getByRole("button", { name: "Default for note" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "NULL for note" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // Typing makes it a value, and the dialog does not change height as you work.
  const before = (await dialog.boundingBox())?.height ?? 0;
  await dialog.getByRole("textbox", { name: "Value for note" }).fill("typed");
  await expect(dialog.getByRole("button", { name: "Default for note" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await dialog.getByRole("button", { name: "NULL for note" }).click();
  await expect(dialog.getByRole("button", { name: "NULL for note" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const after = (await dialog.boundingBox())?.height ?? 0;
  expect(Math.abs(after - before), "add-row: the dialog keeps its height").toBeLessThanOrEqual(1);
  await expect(dialog.getByRole("status")).toContainText("1 NULL");
  // Required fields still waiting for a value are counted as such, not as set.
  await expect(dialog.getByRole("status")).toContainText("2 to fill in");
}

/** The left edge of a control, in pixels. */
async function leftOf(dialog: Locator, label: string): Promise<number> {
  const box = await dialog.getByLabel(label, { exact: true }).boundingBox();
  if (!box) throw new Error(`${label} is not on screen`);
  return Math.round(box.x);
}

/** U3: the builders' cards share one grid, and Array and Can be NULL are buttons (docs/ui-polish-plan.md). */
async function builderRules(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Columns (3)" })).toBeVisible();
  // No lone checkboxes in a card: Array and Can be NULL are toggle buttons.
  expect(
    await dialog
      .locator("[data-slot=builder-card] input[type=checkbox]:not([aria-hidden])")
      .count(),
    "builder: no checkboxes in a card",
  ).toBe(0);
  const array = dialog.getByRole("button", { name: "Array (Column 1)" });
  await expect(array).toHaveAttribute("aria-pressed", "false");
  await array.click();
  await expect(array).toHaveAttribute("aria-pressed", "true");
  await array.click();
  await expect(dialog.getByRole("button", { name: "Can be NULL (Column 2)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // One grid: in every column card the name, default and identity share a left edge, and the type
  // and comment share another; and every card puts them in the same place.
  const leftEdges = new Set<number>();
  const rightEdges = new Set<number>();
  for (const n of [1, 2, 3]) {
    const name = await leftOf(dialog, `Column ${n} name`);
    const type = await leftOf(dialog, `Column ${n} type`);
    expect(await leftOf(dialog, `Column ${n} comment`), `column ${n}: comment under type`).toBe(
      type,
    );
    const identity = dialog.getByLabel(`Column ${n} identity`, { exact: true });
    if (await identity.count()) {
      expect(await leftOf(dialog, `Column ${n} identity`), `column ${n}: identity under name`).toBe(
        name,
      );
    }
    const dflt = dialog.getByLabel(`Column ${n} default`, { exact: true });
    if (await dflt.count()) {
      expect(await leftOf(dialog, `Column ${n} default`), `column ${n}: default under name`).toBe(
        name,
      );
    }
    leftEdges.add(name);
    rightEdges.add(type);
  }
  expect([...leftEdges], "every card starts its first column at the same x").toHaveLength(1);
  expect([...rightEdges], "every card starts its second column at the same x").toHaveLength(1);

  // The foreign key card is on the same grid: schema over column and on delete, table over
  // points at and on update.
  const first = await leftOf(dialog, "Foreign key 1 schema");
  expect(await leftOf(dialog, "Foreign key 1 column 1"), "fk: column under schema").toBe(first);
  expect(await leftOf(dialog, "Foreign key 1 on delete"), "fk: on delete under schema").toBe(first);
  const second = await leftOf(dialog, "Foreign key 1 table");
  expect(
    await leftOf(dialog, "Foreign key 1 referenced column 1"),
    "fk: points at under table",
  ).toBe(second);
  expect(await leftOf(dialog, "Foreign key 1 on update"), "fk: on update under table").toBe(second);
  // And the card's column is aligned with the column cards' second column.
  expect(second, "fk: table starts where the type starts").toBe([...rightEdges][0]);
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
    await editRowRules(page);
    await page.getByRole("textbox", { name: "name", exact: true }).fill("Ada King");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByLabel("The statement that will run")).toBeVisible();
    await inspect(page, "preview", theme);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("The row was changed.")).toBeVisible();

    // --- add row
    await page.getByRole("button", { name: "Add row" }).click();
    await inspect(page, "add-row", theme);
    await addRowRules(page);
    await closeDialog(page);

    // --- new table, with three columns so the form is tall
    await page.getByRole("button", { name: "New table in public" }).click();
    const create = page.getByRole("dialog");
    await create.getByRole("textbox", { name: "Table name" }).fill("ui_made");
    await create.getByRole("button", { name: "Add a column" }).click();
    await create.getByLabel("Column 2 name").fill("label");
    await create.getByRole("button", { name: "Add a column" }).click();
    await create.getByLabel("Column 3 name").fill("amount");
    await create.getByRole("button", { name: "Add a foreign key" }).click();
    await expect(create.getByLabel("Foreign key 1 schema")).toBeVisible();
    await inspect(page, "new-table", theme);
    await builderRules(page);
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

/** U4: the sidebar's writes bar, the Data toolbar and the row actions (docs/ui-polish-plan.md). */
test("the sidebar writes bar, the Data toolbar and the row actions stay compact", async ({
  page,
  writableApp,
  database,
}) => {
  await plant(database);
  await connect(page, writableApp.link, database);
  const sidebar = page.getByRole("complementary", { name: "Connections and schema explorer" });

  // --- unlock: the words are not repeated
  await page.getByRole("switch", { name: "Allow changes to UI shop" }).click();
  const dialog = page.getByRole("dialog");
  const text = (await dialog.innerText()).toLowerCase();
  expect(
    text.split("allow changes to").length - 1,
    "the question is asked once",
  ).toBeLessThanOrEqual(1);
  expect(
    text.split(database.name.toLowerCase()).length - 1,
    "the name is shown twice at most",
  ).toBeLessThanOrEqual(2);
  await page.getByRole("textbox", { name: "Database name" }).fill(database.name);
  await page.getByRole("button", { name: "Allow changes" }).click();

  // --- the bar: badge and two icon buttons on one line, each button at least 28 px, each with a tooltip
  const badge = sidebar.getByText("Writes on");
  await expect(badge).toBeVisible();
  const lock = sidebar.getByRole("button", { name: "Lock writes for UI shop" });
  const history = sidebar.getByRole("button", { name: "Changes made to UI shop in this session" });
  const boxes = await Promise.all([badge, lock, history].map((l) => l.boundingBox()));
  const tops = boxes.map((b) => Math.round((b!.y + b!.height / 2) / 4));
  expect(new Set(tops).size, "badge, lock and changes share one line").toBe(1);
  for (const b of boxes.slice(1)) expect(Math.min(b!.width, b!.height)).toBeGreaterThanOrEqual(28);
  await lock.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Lock writes");

  // --- the Data toolbar: at most two lines at 1280 and at 900
  await page.getByRole("tab", { name: "Table details" }).click();
  await page
    .getByRole("button", { name: /^ui_people\b/ })
    .first()
    .click();
  await expect(page.getByRole("grid")).toBeVisible();
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 800 });
    const lines = await page.evaluate(() => {
      const next = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Next",
      );
      const bar = next?.closest("[data-slot=data-toolbar]");
      if (!bar) return -1;
      const tops = new Set<number>();
      for (const el of bar.querySelectorAll("button, select, [role=switch], [role=status]")) {
        const r = el.getBoundingClientRect();
        tops.add(Math.round((r.top + r.height / 2) / 16));
      }
      return tops.size;
    });
    expect(lines, `the toolbar exists and has at most two lines at ${width}`).toBeGreaterThan(0);
    expect(lines).toBeLessThanOrEqual(2);
  }

  // --- the row actions: a 32 px target and a tooltip
  await page.setViewportSize({ width: 1280, height: 800 });
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "data-toolbar.png") });
  for (const name of ["Edit row 1", "Delete row 1"]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(Math.min(box!.width, box!.height), `${name} is at least 32 px`).toBeGreaterThanOrEqual(
      32,
    );
  }
  await page.getByRole("button", { name: "Edit row 1" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Edit row 1");
});

/** U5: a 375 px phone can connect, pick a table, edit a row and unlock writes (docs/ui-polish-plan.md). */
test("a phone can pick a table, unlock writes and edit a row", async ({
  page,
  writableApp,
  database,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await plant(database);
  await connect(page, writableApp.link, database, true);
  const noOverflow = async (when: string) => {
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(wide, `the page does not scroll sideways ${when}`).toBeLessThanOrEqual(0);
  };
  await noOverflow("after connecting");

  // --- the sidebar is a drawer behind a menu button in the header
  const sidebar = page.getByRole("complementary", { name: "Connections and schema explorer" });
  await expect(sidebar).toBeHidden();
  const menu = page.getByRole("button", { name: "Open connections and tables" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(sidebar).toBeVisible();
  const drawer = await sidebar.boundingBox();
  expect(drawer!.x, "the drawer starts at the left edge").toBeLessThanOrEqual(0);
  expect(drawer!.width, "the drawer leaves room to see the page behind it").toBeLessThan(375);

  // --- unlock from the drawer
  await sidebar.getByRole("switch", { name: "Allow changes to UI shop" }).click();
  await page.getByRole("textbox", { name: "Database name" }).fill(database.name);
  await page.getByRole("button", { name: "Allow changes" }).click();
  await expect(sidebar.getByText("Writes on")).toBeVisible();

  // --- picking a table closes the drawer
  await sidebar.getByRole("textbox", { name: "Find a table" }).fill("ui_people");
  await sidebar
    .getByRole("list", { name: "Matches in public" })
    .getByRole("button")
    .first()
    .click();
  await expect(sidebar).toBeHidden();

  // --- the view tabs scroll, and the Data controls are one scrolling row
  await page
    .getByRole("tab", { name: "Table details" })
    .click({ trial: true })
    .catch(() => {});
  const tabs = page.getByRole("tablist", { name: "View" });
  const scrolls = await tabs.evaluate(
    (el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX !== "visible",
  );
  expect(scrolls, "the view tabs scroll sideways").toBe(true);
  await page.getByRole("tab", { name: "Table details" }).scrollIntoViewIfNeeded();
  await page.getByRole("tab", { name: "Table details" }).click();
  await expect(page.getByRole("grid")).toBeVisible();
  const bar = await page.locator("[data-slot=data-toolbar]").evaluate((el) => {
    const tops = new Set<number>();
    for (const c of el.querySelectorAll("button, select, [role=switch]")) {
      const r = c.getBoundingClientRect();
      tops.add(Math.round((r.top + r.height / 2) / 16));
    }
    return { lines: tops.size, scrolls: el.scrollWidth > el.clientWidth };
  });
  expect(bar.lines, "the Data controls are one row").toBe(1);
  expect(bar.scrolls, "and that row scrolls").toBe(true);
  await noOverflow("on the Data section");

  // --- a form dialog is a full-screen sheet
  await page.getByRole("button", { name: "Edit row 1" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350);
  const box = await dialog.boundingBox();
  expect(Math.round(box!.width), "the sheet is as wide as the screen").toBe(375);
  expect(Math.round(box!.height), "the sheet is as tall as the screen").toBe(812);
  await expect(dialog.getByRole("button", { name: "Preview" })).toBeInViewport({ ratio: 1 });
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "phone-edit-row.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "phone-data.png") });
  await page.getByRole("button", { name: "Open connections and tables" }).click();
  await expect(sidebar).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, "phone-drawer.png") });
});
