/**
 * The statistics of a table in the details (1.10.0, V3; docs/insight-release-plan.md, section 6; decision 165): the
 * share of NULLs, distinct values, widths, sizes and upkeep from the server's own statistics. They read no row, so they
 * are there with "Allow viewing table data" OFF, and no value of the table is on the screen. axe in both themes.
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

async function open(page: Page, link: string, database: TestDb, table: string) {
  await admin(
    database,
    `CREATE TABLE public.ts_people (id int PRIMARY KEY, email text NOT NULL, qty int, note text);
     INSERT INTO public.ts_people
       SELECT i, 'MARKER-EMAIL-' || i, i % 10, CASE WHEN i % 2 = 0 THEN 'MARKER-NOTE' END
       FROM generate_series(1, 1000) i;
     ANALYZE public.ts_people;
     CREATE TABLE public.ts_fresh (id int PRIMARY KEY, v text) WITH (autovacuum_enabled = false);
     INSERT INTO public.ts_fresh SELECT i, 'MARKER-FRESH' FROM generate_series(1, 100) i;`,
  );
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Stats shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  // Allow viewing table data stays OFF: the statistics read no row.
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Stats shop" })).toBeVisible();
  await page.getByRole("tab", { name: "Table details" }).click();
  await page
    .getByRole("button", { name: new RegExp(`^${table}\\b`) })
    .first()
    .click();
}

test.describe("table statistics", () => {
  test("shows the figures of an analysed table without data viewing, and not one value of the table", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database, "ts_people");
    await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Statistics" }) });
    await expect(section.getByText("Rows (estimate)")).toBeVisible();
    await expect(section.getByText("1,000", { exact: true }).first()).toBeVisible();
    const columns = section.getByRole("table", { name: "Statistics of the columns of the table" });
    // `note` is NULL in half of its rows; `email` is different in every row; `qty` has ten values.
    await expect(columns.getByRole("row", { name: /^note\b.*50%/ })).toBeVisible();
    await expect(columns.getByRole("row", { name: /^email\b.*all different/ })).toBeVisible();
    await expect(columns.getByRole("row", { name: /^qty\b.*10 distinct/ })).toBeVisible();
    // Nothing of the table's values is on the page.
    expect(await page.locator("body").innerText()).not.toContain("MARKER");
  });

  test("says that a table that was never analysed has no figures, in words", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database, "ts_fresh");
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Statistics" }) });
    await expect(section.getByRole("status")).toContainText("never been analysed");
    await expect(section.getByText("No figures").first()).toBeVisible();
  });

  test("passes axe in light and in dark", async ({ page, app, database }) => {
    await open(page, app.link, database, "ts_people");
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Statistics" }) });
    await expect(section.getByText("Rows (estimate)")).toBeVisible();
    await section.scrollIntoViewIfNeeded();
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
        const heading = [...document.querySelectorAll("h3")].find((h) =>
          h.textContent?.startsWith("Statistics"),
        );
        const result = await axe.run(heading?.closest("section") ?? document.body, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        });
        return result.violations.map((v) => `${v.id} (${v.impact})`);
      });
      expect.soft(found, `axe on the statistics (${name})`).toEqual([]);
    };
    await check("light");
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await check("dark");
  });
});
