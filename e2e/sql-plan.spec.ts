/**
 * The plan viewer of the SQL tab (1.10.0, V2; docs/insight-release-plan.md, section 5; decision 164): EXPLAIN as a
 * tree with the numbers of each step and what deserves the eye, a plan of any size kept whole (the grid cuts every other
 * cell at 2,000 characters), the JSON as it came, and axe in both themes.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, settleForAxe, type TestDb } from "./fixtures";

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

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
    `CREATE TABLE public.p_items (id int PRIMARY KEY, v text);
     INSERT INTO public.p_items SELECT i, 'v' || i FROM generate_series(1, 2000) i;
     ANALYZE public.p_items;`,
  );
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Plan shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Plan shop" })).toBeVisible();
  await page.getByRole("tab", { name: "SQL" }).click();
}

const focusEditor = (page: Page) => page.locator(".monaco-editor .view-lines").first().click();
async function typeSql(page: Page, text: string) {
  await focusEditor(page);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}
const resultPanel = (page: Page) => page.getByRole("region", { name: "Result" });
const tree = (page: Page) => resultPanel(page).getByLabel("Query plan as a tree");

async function explain(page: Page, item: RegExp) {
  await page.getByRole("button", { name: "Explain" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test.describe("the plan viewer", () => {
  test("shows a plan as a tree, says it was not run, and switches to the JSON as it came", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database);
    await typeSql(page, "SELECT * FROM p_items WHERE v = 'v5'");
    await explain(page, /^Explain as a tree/);
    await expect(tree(page)).toBeVisible();
    await expect(tree(page)).toContainText("Seq Scan on p_items");
    await expect(tree(page)).toContainText("Filter:");
    await expect(resultPanel(page)).toContainText("not run: the numbers are the planner's guesses");

    await resultPanel(page).getByRole("button", { name: "JSON text" }).click();
    await expect(resultPanel(page).getByLabel("Query plan", { exact: true })).toContainText(
      '"Node Type"',
    );
    await resultPanel(page).getByRole("button", { name: "Tree" }).click();
    await expect(tree(page)).toBeVisible();
  });

  test("a plan that was run shows the rows it got, the time and the buffers, and marks a wrong guess in words", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database);
    await typeSql(
      page,
      // The planner expects about one row for each of these (no statistics for the expression): it gets 2,000.
      "SELECT * FROM p_items WHERE (id % 1) = 0",
    );
    await explain(page, /^Explain analyze as a tree/);
    await expect(tree(page)).toContainText("got");
    await expect(tree(page)).toContainText("buffers");
    await expect(resultPanel(page)).toContainText("execution");
    await expect(tree(page)).toContainText(/The planner expected [\d,]+ rows and got 2,000/);
  });

  test("keeps a plan far past the 2,000 characters of any other cell, whole", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database);
    const branches = Array.from({ length: 60 }, (_, i) => `SELECT ${i} AS a`).join(" UNION ALL ");
    await typeSql(page, branches);
    await explain(page, /^Explain as a tree/);
    await expect(tree(page)).toContainText("Append");
    await expect(resultPanel(page)).toContainText("61 steps");
  });

  test("a plan in the text format is still shown as text", async ({ page, app, database }) => {
    await open(page, app.link, database);
    await typeSql(page, "SELECT * FROM p_items");
    await explain(page, /^Explain Shows the plan/);
    await expect(resultPanel(page).getByLabel("Query plan")).toContainText("Seq Scan");
    await expect(resultPanel(page).getByRole("button", { name: "JSON text" })).toHaveCount(0);
  });

  test("passes axe in light and in dark", async ({ page, app, database }) => {
    await open(page, app.link, database);
    await typeSql(page, "SELECT * FROM p_items WHERE (id % 1) = 0");
    await explain(page, /^Explain analyze as a tree/);
    await expect(tree(page)).toBeVisible();
    const check = async (name: string) => {
      await settleForAxe(page);
      await page.addScriptTag({ content: axeSource });
      const found = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: {
              run: (
                c: Element,
                o: object,
              ) => Promise<{ violations: Array<{ id: string; impact: string | null }> }>;
            };
          }
        ).axe;
        const result = await axe.run(
          document.querySelector('[aria-label="Result"]') ?? document.body,
          {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          },
        );
        return result.violations.map((v) => `${v.id} (${v.impact})`);
      });
      expect.soft(found, `axe on the plan (${name})`).toEqual([]);
    };
    await check("light");
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await check("dark");
  });
});
