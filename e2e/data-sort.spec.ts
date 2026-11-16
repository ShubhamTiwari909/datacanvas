/**
 * Sorting the rows of a table from the column headers, end to end: the click cycle,
 * paging through a sorted table, the columns that cannot be sorted and why, a hidden
 * column that can be sorted once shown, and a table without a key.
 */
import pg from "pg";
import { expect, test, type TestDb } from "./fixtures";
import type { Page } from "@playwright/test";

interface Item {
  id: number;
  name: string | null;
  score: number;
}

// Names are lowercase letters so the database's collation and JavaScript agree on the order.
const ITEMS: Item[] = Array.from({ length: 60 }, (_, index) => {
  const id = index + 1;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return {
    id,
    name: id === 5 || id === 17 ? null : `${letters[(id * 7) % 26]}${letters[id % 26]}${id}`,
    score: (id * 7) % 13, // many ties, so the key has work to do
  };
});

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
    const values = ITEMS.map(
      (item) =>
        `(${item.id}, ${item.name === null ? "NULL" : `'${item.name}'`}, ${item.score}, 'n${item.id}', '{}', 'hash-${item.id}')`,
    ).join(", ");
    await client.query(`
      CREATE TABLE public.ds_items (
        id integer PRIMARY KEY, name text, score integer, note text, data jsonb, password_hash text
      );
      INSERT INTO public.ds_items VALUES ${values};
      CREATE TABLE public.ds_nokey (v integer, w text);
      INSERT INTO public.ds_nokey VALUES (3, 'c'), (1, 'a'), (2, 'b');
    `);
  } finally {
    await client.end();
  }
}

async function connect(page: Page, database: TestDb, app: { link: string }): Promise<void> {
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sort shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Sort shop" })).toBeVisible();
}

async function openTable(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("tab", { name: "Table details" }).click();
  await page.getByRole("button", { name }).first().click();
  await expect(page.getByRole("grid")).toBeVisible();
}

const grid = (page: Page) => page.getByRole("grid");
/** The header of a column (a `th`), found by its name button or its plain name. */
const header = (page: Page, name: string) =>
  page.locator("th").filter({ has: page.getByText(name, { exact: true }) });
const sortButton = (page: Page, name: string) =>
  page.getByRole("button", { name: `Sort by ${name}`, exact: true });

/**
 * The ids shown on the current page, in order (the first column), once it has loaded: the page being left
 * stays on screen, dimmed (`aria-busy`), while the next one is read, and "Page 2" shows at once.
 */
async function shownIds(page: Page): Promise<string[]> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  return (await grid(page).locator("tbody tr td:first-child").allInnerTexts()).map((t) => t.trim());
}

/** The ids the database should give, sorted the way it sorts: NULL last when ascending, first when descending; the id breaks ties. */
function expectedIds(
  rank: (item: Item) => string | number | null,
  direction: "asc" | "desc",
): string[] {
  const compare = (a: Item, b: Item): number => {
    const x = rank(a);
    const y = rank(b);
    let result: number;
    if (x === null || y === null) result = x === y ? 0 : x === null ? 1 : -1;
    else result = x < y ? -1 : x > y ? 1 : 0;
    return (direction === "asc" ? result : -result) || a.id - b.id;
  };
  return [...ITEMS].sort(compare).map((item) => String(item.id));
}

test.describe("sorting the rows", () => {
  test.beforeEach(async ({ page, app, database }) => {
    await plant(database);
    await connect(page, database, app);
  });

  test("a header cycles ascending, descending and back, and the page says how it is ordered", async ({
    page,
  }) => {
    await openTable(page, /^ds_items\b/);
    await page.getByLabel("Rows per page").selectOption("100");
    await expect(page.getByText("Ordered by id (the primary key).")).toBeVisible();
    await expect(header(page, "score")).toHaveAttribute("aria-sort", "none");

    await sortButton(page, "score").click();
    await expect(header(page, "score")).toHaveAttribute("aria-sort", "ascending");
    await expect(
      page.getByText("Ordered by score (ascending, NULL last), then by id (the primary key)."),
    ).toBeVisible();
    await expect.poll(() => shownIds(page)).toEqual(expectedIds((i) => i.score, "asc"));

    await sortButton(page, "score").click();
    await expect(header(page, "score")).toHaveAttribute("aria-sort", "descending");
    await expect(page.getByText(/Ordered by score \(descending, NULL first\)/)).toBeVisible();
    await expect.poll(() => shownIds(page)).toEqual(expectedIds((i) => i.score, "desc"));

    await sortButton(page, "score").click();
    await expect(header(page, "score")).toHaveAttribute("aria-sort", "none");
    await expect(page.getByText("Ordered by id (the primary key).")).toBeVisible();
    await expect.poll(() => shownIds(page)).toEqual(expectedIds((i) => i.id, "asc"));
  });

  test("sorting another column replaces the sort, and NULL goes where the database puts it", async ({
    page,
  }) => {
    await openTable(page, /^ds_items\b/);
    await page.getByLabel("Rows per page").selectOption("100");
    await sortButton(page, "score").click();
    await sortButton(page, "name").click();
    await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
    await expect(header(page, "score")).toHaveAttribute("aria-sort", "none");
    await expect.poll(() => shownIds(page)).toEqual(expectedIds((i) => i.name, "asc"));
    // The two NULL names come last when ascending ...
    expect((await shownIds(page)).slice(-2)).toEqual(["5", "17"]);
    // ... and first when descending.
    await sortButton(page, "name").click();
    await expect.poll(async () => (await shownIds(page)).slice(0, 2)).toEqual(["5", "17"]);
  });

  test("pages through a sorted table, each row once, and starts again from page 1 when the sort changes", async ({
    page,
  }) => {
    await openTable(page, /^ds_items\b/);
    await page.getByLabel("Rows per page").selectOption("25");
    await sortButton(page, "score").click();
    await expect(page.getByText(/^Page 1/)).toBeVisible();

    const seen: string[] = [...(await shownIds(page))];
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText(/^Page 2/)).toBeVisible();
    seen.push(...(await shownIds(page)));
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText(/^Page 3/)).toBeVisible();
    seen.push(...(await shownIds(page)));
    expect(seen).toEqual(expectedIds((i) => i.score, "asc"));
    expect(new Set(seen).size).toBe(60);
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

    // Back one page keeps the order; changing the sort starts again from the first page.
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(page.getByText(/^Page 2/)).toBeVisible();
    await sortButton(page, "name").click();
    await expect(page.getByText(/^Page 1/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
    await expect.poll(() => shownIds(page)).toEqual(expectedIds((i) => i.name, "asc").slice(0, 25));
  });

  test("a column that cannot be sorted has no button and says why", async ({ page }) => {
    await openTable(page, /^ds_items\b/);
    // jsonb: it has an order in the database, but one that means nothing to a person.
    await expect(sortButton(page, "data")).toHaveCount(0);
    await expect(header(page, "data").getByText("data", { exact: true })).toHaveAttribute(
      "title",
      /no useful order/,
    );
    await expect(header(page, "data")).not.toHaveAttribute("aria-sort", /.+/);
    // A column that can be sorted has a button, with the next action as its tooltip.
    await expect(sortButton(page, "name")).toHaveAttribute("title", "Sort ascending");
  });

  test("a hidden column can be sorted only once it is shown, and the sort goes when it is hidden again", async ({
    page,
  }) => {
    await openTable(page, /^ds_items\b/);
    await expect(sortButton(page, "password_hash")).toHaveCount(0);
    await expect(
      header(page, "password_hash").getByText("password_hash", { exact: true }),
    ).toHaveAttribute("title", /hidden column cannot be sorted/);

    await page.getByRole("button", { name: "Show the hidden column password_hash" }).click();
    await sortButton(page, "password_hash").click();
    await expect(header(page, "password_hash")).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByText(/Ordered by password_hash \(ascending/)).toBeVisible();

    await page.getByRole("button", { name: "Hide the column password_hash again" }).click();
    await expect(page.getByText("Ordered by id (the primary key).")).toBeVisible();
    await expect(page.getByText(/^Page 1/)).toBeVisible();
    await expect(sortButton(page, "password_hash")).toHaveCount(0);
  });

  test("a table without a key cannot be sorted, and says so", async ({ page }) => {
    await openTable(page, /^ds_nokey\b/);
    await expect(page.getByRole("button", { name: /^Sort by / })).toHaveCount(0);
    await expect(header(page, "v").getByText("v", { exact: true })).toHaveAttribute(
      "title",
      /no primary key or unique index/,
    );
    await expect(page.getByText(/no key to order by/)).toBeVisible();
  });

  test("works from the keyboard: Tab to a header and press Enter", async ({ page }) => {
    await openTable(page, /^ds_items\b/);
    await sortButton(page, "score").focus();
    await page.keyboard.press("Enter");
    await expect(header(page, "score")).toHaveAttribute("aria-sort", "ascending");
    await page.keyboard.press("Space");
    await expect(header(page, "score")).toHaveAttribute("aria-sort", "descending");
  });

  test("a sorted view is in the page and nowhere else: nothing in the browser's storage", async ({
    page,
  }) => {
    await openTable(page, /^ds_items\b/);
    await sortButton(page, "name").click();
    await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toMatch(/"column"|"direction"|ds_items|name/i);
    // Another table starts unsorted.
    await openTable(page, /^ds_nokey\b/);
    await openTable(page, /^ds_items\b/);
    await expect(header(page, "name")).toHaveAttribute("aria-sort", "none");
  });
});
