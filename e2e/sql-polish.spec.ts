/**
 * The SQL view's finish (1.6.0, S6): the editor in the app's colours in both themes, axe-core
 * (WCAG 2.0 and 2.1, A and AA) on the view with a result, an error and the dialogs, a phone,
 * the role notice, and how fast it opens and shows 10,000 rows.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb, settleForAxe } from "./fixtures";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.SQL_VIEW_DIR ?? path.join(here, "../test-results/sql-view");
const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

interface AxeResult {
  violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: unknown[] }> }>;
}

async function admin(database: TestDb, text: string): Promise<void> {
  const c = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await c.connect();
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
}

async function open(page: Page, link: string, database: TestDb) {
  await admin(
    database,
    `CREATE TABLE public.s_items (id int PRIMARY KEY, v text);
     INSERT INTO public.s_items VALUES (1, 'one'), (2, NULL), (3, '');`,
  );
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sql shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  // On a phone the sidebar is a drawer: the connect dialog closing is how to tell it worked.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "SQL" }).click();
}

const resultPanel = (page: Page) => page.getByRole("region", { name: "Result" });
const run = (page: Page) => page.getByRole("button", { name: "Run", exact: true });

async function typeSql(page: Page, text: string) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

// Types a statement and runs it, and tries again if the editor was not ready to take the click.
async function runUntil(page: Page, text: string, shown: () => Promise<void>) {
  await expect(async () => {
    await typeSql(page, text);
    await run(page).click();
    await shown();
  }).toPass({ timeout: 30_000 });
}

async function axeOn(page: Page, name: string, within = "body"): Promise<void> {
  await settleForAxe(page);
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async (within) => {
    const axe = (
      window as unknown as { axe: { run: (c: Element, o: object) => Promise<AxeResult> } }
    ).axe;
    const root = document.querySelector(within);
    if (!root) throw new Error(`nothing matches ${within}`);
    return axe.run(root, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  }, within);
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

async function chooseTheme(page: Page, name: "Light" | "Dark") {
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

test("the editor wears the app's colours in light and dark", async ({ page, app, database }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, app.link, database);
  await expect(page.getByRole("textbox", { name: /SQL editor/ })).toBeVisible();
  // Both are read as the colour the browser paints: one is written as lab(), the other as rgb().
  const colours = () =>
    page.evaluate(() => {
      const paint = (css: string) => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(",");
      };
      const editor = document.querySelector(".monaco-editor .monaco-editor-background");
      return {
        editor: editor ? paint(getComputedStyle(editor).backgroundColor) : null,
        page: paint(getComputedStyle(document.body).backgroundColor),
      };
    });
  const light = await colours();
  expect(light.editor).toBe(light.page);
  await chooseTheme(page, "Dark");
  await expect.poll(async () => (await colours()).page).not.toBe(light.page);
  const dark = await colours();
  expect(dark.editor).toBe(dark.page);
});

test("passes axe with a result, an error, the menus and the history, in both themes", async ({
  page,
  app,
  database,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, app.link, database);
  mkdirSync(shots, { recursive: true });

  for (const theme of ["Light", "Dark"] as const) {
    await chooseTheme(page, theme);
    const label = theme.toLowerCase();

    await runUntil(page, "SELECT id, v FROM public.s_items ORDER BY id", () =>
      expect(resultPanel(page).getByRole("grid")).toBeVisible({ timeout: 5000 }),
    );
    await page.screenshot({ path: path.join(shots, `sql-result-${label}.png`) });
    await axeOn(page, `a result (${label})`);

    await runUntil(page, "SELECT * FROM public.nope", () =>
      expect(resultPanel(page).getByRole("alert")).toBeVisible({ timeout: 5000 }),
    );
    await page.screenshot({ path: path.join(shots, `sql-error-${label}.png`) });
    await axeOn(page, `an error (${label})`);

    await page.getByRole("button", { name: "Explain" }).click();
    await expect(
      page.getByRole("menuitem", {
        name: /^Explain analyze Runs the statement, and shows the plan/,
      }),
    ).toBeVisible();
    await page.waitForTimeout(350); // the open animation: colours are mid-fade before it ends
    // A menu hides the page behind it from assistive technology, so it is checked on its own.
    await axeOn(page, `the explain menu (${label})`, "[role=menu]");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Query history" }).click();
    await expect(page.getByRole("dialog", { name: "Query history" })).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(shots, `sql-history-${label}.png`) });
    await axeOn(page, `the history (${label})`, "[role=dialog]");
    await page.keyboard.press("Escape");
  }
});

test("works on a phone: no sideways scroll, every control reachable, a result readable", async ({
  page,
  app,
  database,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, app.link, database);
  await typeSql(page, "SELECT id, v FROM public.s_items ORDER BY id");
  await run(page).click();
  await expect(resultPanel(page).getByRole("grid")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "sql-phone.png") });
  // The controls are all on screen, wrapped, not cut off.
  for (const name of ["Run", "Explain", "Query history", "New query tab", "Duplicate query tab"]) {
    const box = await page
      .getByRole("button", { name, exact: name === "Run" })
      .first()
      .boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x, name).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, name).toBeLessThanOrEqual(375);
    expect(box!.height, name).toBeGreaterThanOrEqual(24);
  }
});

test("says so when the role can reach the database server's files or programs", async ({
  page,
  app,
  database,
}) => {
  // The test database role is a superuser.
  await open(page, app.link, database);
  const note = page.getByRole("note", { name: "About this role" });
  await expect(note).toContainText("is a superuser");
  await expect(note).toContainText("A read-only transaction stops every write");
  await expect(note).toContainText("dblink");
});

test("opens quickly and shows 10,000 rows without trouble", async ({ page, app, database }) => {
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sql shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: /Disconnect Sql shop/ })).toBeVisible();

  const opening = Date.now();
  await page.getByRole("tab", { name: "SQL" }).click();
  await expect(page.getByRole("textbox", { name: /SQL editor/ })).toBeVisible();
  const openMs = Date.now() - opening;

  await typeSql(
    page,
    "SELECT g AS n, md5(g::text) AS hash, g * 2 AS twice, 'row ' || g AS label FROM generate_series(1, 10000) g",
  );
  await page.getByLabel("Row limit").selectOption("10000");
  const started = Date.now();
  await run(page).click();
  const grid = resultPanel(page).getByRole("grid", { name: "Query result" });
  await expect(grid.getByRole("row")).toHaveCount(10_001, { timeout: 30_000 });
  const showMs = Date.now() - started;

  // Scrolling to the bottom and back stays responsive.
  const scrolled = Date.now();
  await grid.evaluate((el) => {
    const box = el.parentElement!;
    box.scrollTo({ top: box.scrollHeight });
  });
  await expect(grid.getByRole("row").last()).toContainText("10000");
  const scrollMs = Date.now() - scrolled;
  // The box really moved to its end, and back again.
  const position = () =>
    grid.evaluate((el) => {
      const box = el.parentElement!;
      return {
        top: box.scrollTop,
        atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2,
      };
    });
  expect((await position()).atEnd).toBe(true);
  await grid.evaluate((el) => el.parentElement!.scrollTo({ top: 0 }));
  expect((await position()).top).toBe(0);
  console.log(`sql view: open ${openMs} ms, 10,000 rows shown ${showMs} ms, scroll ${scrollMs} ms`);
  // Generous ceilings: they catch a hang or a quadratic render, not a slow shared CI runner.
  expect(openMs).toBeLessThan(10_000);
  expect(showMs).toBeLessThan(15_000);
  expect(scrollMs).toBeLessThan(6000);
});
