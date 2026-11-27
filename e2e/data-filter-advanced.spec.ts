/**
 * The newer filters from the Filter panel, end to end (1.8.0, D1): lists and ranges, groups of
 * conditions joined by OR, JSON and array tests, the date shortcuts, "filter by this value" from a
 * cell, saved filter shapes (the values are never kept), axe in both themes, and a phone.
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
      CREATE TABLE public.af_things (
        id integer PRIMARY KEY, name text, score integer, born date, doc jsonb, tags text[]
      );
      INSERT INTO public.af_things VALUES
        (1, 'ann', 1, current_date, '{"k": 1, "a": {"b": [10, 20]}}', '{x,y}'),
        (2, 'bob', 2, current_date - 3, '{"k": 2}', '{y}'),
        (3, 'cat', 3, current_date - 10, '{"z": null}', '{}'),
        (4, 'dan', 4, current_date - 40, NULL, NULL),
        (5, 'eve', 5, NULL, '{"k": 1}', '{x}');
    `);
  } finally {
    await client.end();
  }
}

const grid = (page: Page) => page.getByRole("grid");
const panel = (page: Page) => page.getByRole("form", { name: "Add a filter" });
const chips = (page: Page) =>
  page.getByRole("list", { name: "Active filters" }).getByRole("listitem");
const filterButton = (page: Page) => page.getByRole("button", { name: /^Filter\b/ });

async function shownIds(page: Page): Promise<string[]> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  return (await grid(page).locator("tbody tr td[data-col='0']").allInnerTexts()).map((t) =>
    t.trim(),
  );
}

interface Condition {
  column: string;
  condition: string;
  value?: string;
  list?: string;
  from?: string;
  to?: string;
  path?: string;
  combine?: string;
}

async function add(page: Page, c: Condition): Promise<void> {
  if ((await panel(page).count()) === 0) await filterButton(page).click();
  await panel(page).getByLabel("Column").selectOption(c.column);
  await panel(page).getByLabel("Condition").selectOption({ label: c.condition });
  if (c.path !== undefined) await panel(page).getByLabel("Path", { exact: true }).fill(c.path);
  if (c.value !== undefined) await panel(page).getByLabel("Value", { exact: true }).fill(c.value);
  if (c.list !== undefined) await panel(page).getByLabel("Values, one per line").fill(c.list);
  if (c.from !== undefined) await panel(page).getByLabel("From (included)").fill(c.from);
  if (c.to !== undefined) await panel(page).getByLabel("To (included)").fill(c.to);
  if (c.combine !== undefined)
    await panel(page).getByLabel("Combine").selectOption({ label: c.combine });
  await panel(page).getByRole("button", { name: "Add filter" }).click();
}

async function clearAll(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(chips(page)).toHaveCount(0);
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

test.describe("the newer filters", () => {
  test.beforeEach(async ({ page, app, database }) => {
    await plant(database);
    await page.goto(app.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("Filters shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByLabel("Allow viewing table data").check();
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect Filters shop" })).toBeVisible();
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^af_things\b/ })
      .first()
      .click();
    await expect(grid(page)).toBeVisible();
  });

  test("lists, ranges and the date shortcuts", async ({ page }) => {
    await add(page, { column: "score", condition: "is one of", list: "1\n3\n5" });
    await expect.poll(() => shownIds(page)).toEqual(["1", "3", "5"]);
    await expect(chips(page).first()).toContainText('score is one of "1", "3", "5"');
    await clearAll(page);

    await add(page, { column: "score", condition: "is between", from: "2", to: "4" });
    await expect.poll(() => shownIds(page)).toEqual(["2", "3", "4"]);
    await clearAll(page);

    await add(page, { column: "born", condition: "is in the last 7 days" });
    await expect.poll(() => shownIds(page)).toEqual(["1", "2"]);
  });

  test("groups: any one of a group is enough, the rest are required", async ({ page }) => {
    await add(page, { column: "score", condition: "is at least", value: "4" });
    await add(page, {
      column: "name",
      condition: "starts with",
      value: "d",
      combine: "Any of group A (or)",
    });
    await add(page, {
      column: "name",
      condition: "starts with",
      value: "e",
      combine: "Any of group A (or)",
    });
    await expect.poll(() => shownIds(page)).toEqual(["4", "5"]);
    await expect(chips(page).nth(1)).toContainText("(any of A)");
    await expect(
      page.getByText(/Filtered: score is at least "4"; name starts with "d" \(any of A\); /),
    ).toBeVisible();
    // Without the group the same two conditions would match nobody.
    await page.getByRole("button", { name: /Remove filter name starts with "e"/ }).click();
    await expect.poll(() => shownIds(page)).toEqual(["4"]);
  });

  test("JSON by key, by what it contains and by a path; arrays by what they hold", async ({
    page,
  }) => {
    await add(page, { column: "doc", condition: "has the key", value: "k" });
    await expect.poll(() => shownIds(page)).toEqual(["1", "2", "5"]);
    await clearAll(page);
    await add(page, { column: "doc", condition: "contains the JSON", value: '{"k": 1}' });
    await expect.poll(() => shownIds(page)).toEqual(["1", "5"]);
    await clearAll(page);
    await add(page, { column: "doc", condition: "at a path equals", path: "a.b.1", value: "20" });
    await expect.poll(() => shownIds(page)).toEqual(["1"]);
    await expect(chips(page).first()).toContainText('doc at a.b.1 equals "20"');
    await clearAll(page);

    await add(page, { column: "tags", condition: "contains all of", list: "x" });
    await expect.poll(() => shownIds(page)).toEqual(["1", "5"]);
    await clearAll(page);
    await add(page, { column: "tags", condition: "is an empty list" });
    await expect.poll(() => shownIds(page)).toEqual(["3"]);
  });

  test("filter by this value, from the value of a cell", async ({ page }) => {
    await grid(page).getByRole("gridcell", { name: "bob", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Filter by this value" }).click();
    await expect(chips(page).first()).toContainText('name equals "bob"');
    await expect.poll(() => shownIds(page)).toEqual(["2"]);
  });

  test("a saved shape keeps the columns and conditions, never the values", async ({ page }) => {
    await add(page, { column: "name", condition: "starts with", value: "SECRET-PREFIX-zzz" });
    await add(page, { column: "score", condition: "is at least", value: "777" });
    await page
      .getByRole("textbox", { name: "Save these filters as a shape" })
      .fill("Prefix and score");
    await page.getByRole("button", { name: "Save shape" }).click();
    await expect(page.getByText(/Saved "Prefix and score"/)).toBeVisible();

    const stored = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith("datacanvas:filter-shapes"))
        .map(([, value]) => value)
        .join(""),
    );
    expect(stored).toContain("Prefix and score");
    expect(stored).toContain("starts_with");
    expect(stored).not.toContain("SECRET-PREFIX");
    expect(stored).not.toContain("777");

    await clearAll(page);
    await page.getByRole("button", { name: "Prefix and score", exact: true }).click();
    const fill = page.getByRole("form", { name: "Fill in Prefix and score" });
    await expect(fill.getByRole("button", { name: "Add these filters" })).toBeDisabled();
    const values = fill.getByLabel("Value", { exact: true });
    await values.nth(0).fill("c");
    await values.nth(1).fill("2");
    await fill.getByRole("button", { name: "Add these filters" }).click();
    await expect(chips(page)).toHaveCount(2);
    await expect.poll(() => shownIds(page)).toEqual(["3"]);

    await page.getByRole("button", { name: "Delete the saved filters Prefix and score" }).click();
    await expect(page.getByRole("button", { name: "Prefix and score", exact: true })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        () =>
          Object.entries(localStorage).find(([key]) =>
            key.startsWith("datacanvas:filter-shapes:v2:"),
          )?.[1],
      ),
    ).toBe("[]");
  });

  test("keeps a saved template off another connection to the same table", async ({
    page,
    database,
  }) => {
    await add(page, { column: "name", condition: "starts with", value: "a" });
    await page
      .getByRole("textbox", { name: "Save these filters as a shape" })
      .fill("Original connection only");
    await page.getByRole("button", { name: "Save shape" }).click();
    const name = page.getByRole("button", { name: "Original connection only", exact: true });
    await expect(name).toBeVisible();

    await page.getByRole("button", { name: "Add a connection" }).click();
    await page.getByLabel("Connection name").fill("Temporary filters shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByRole("dialog").getByLabel("Allow viewing table data").check();
    await page.getByLabel("Save this connection for next time").uncheck();
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(
      page.getByRole("button", { name: "Disconnect Temporary filters shop" }),
    ).toBeVisible();
    const openTable = () =>
      page
        .getByRole("button", { name: /^af_things\b/ })
        .first()
        .click();
    await openTable();
    await expect(grid(page)).toBeVisible();
    await expect(name).toHaveCount(0);

    await page.getByRole("button", { name: /^Filters shop / }).click();
    await openTable();
    await expect(name).toBeVisible();
  });

  test("passes axe in light and dark with the panel and the saved shapes, and fits a phone", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await add(page, { column: "score", condition: "is one of", list: "1\n2" });
    await page.getByRole("textbox", { name: "Save these filters as a shape" }).fill("Two scores");
    await page.getByRole("button", { name: "Save shape" }).click();
    // The panel is still open after adding a condition.
    await panel(page).getByLabel("Condition").selectOption({ label: "is between" });

    for (const theme of ["Light", "Dark"] as const) {
      await page.getByRole("button", { name: /^Theme:/ }).click();
      await page.getByRole("menuitemradio", { name: theme }).click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await axeOn(page, `the filter panel (${theme.toLowerCase()})`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "no sideways scrolling on a phone").toBeLessThanOrEqual(0);
    await axeOn(page, "the filter panel (phone)");
  });
});
