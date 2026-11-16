/**
 * Filtering the rows of a table from the Filter panel, end to end: adding and removing
 * conditions, what each kind of column offers, combining them with a sort and paging,
 * the limit of three, and the states (no match, a value that does not fit, a read that
 * took too long). A condition's value never reaches the page's storage.
 */
import pg from "pg";
import { expect, test, type TestDb } from "./fixtures";
import type { Page } from "@playwright/test";

interface Person {
  id: number;
  name: string;
  email: string;
  score: number;
  joined: string | null;
}

const NAMES = ["ann", "bob", "cat", "dan", "eve", "fay", "gus", "hal", "ivy", "jon"];
const PEOPLE: Person[] = Array.from({ length: 50 }, (_, index) => {
  const id = index + 1;
  const name = `${NAMES[(id * 3) % 10]}${id}`;
  return {
    id,
    name,
    email: `${name}@x.test`,
    score: (id * 7) % 13,
    joined: id % 7 === 0 ? null : `2020-01-${String(1 + (id % 28)).padStart(2, "0")}`,
  };
});
// Characters that are wildcards in LIKE: here they must be ordinary characters.
const ODD = ["a%b", "a_b", "back\\slash"];

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
      CREATE TABLE public.df_people (
        id integer PRIMARY KEY, name text, email text, score integer, joined date,
        data jsonb, password_hash text
      );
      CREATE TABLE public.df_locked (id integer PRIMARY KEY, name text);
      INSERT INTO public.df_locked VALUES (1, 'a'), (2, 'b');
    `);
    for (const p of PEOPLE) {
      await client.query(
        "INSERT INTO public.df_people (id, name, email, score, joined, password_hash) VALUES ($1, $2, $3, $4, $5, $6)",
        [p.id, p.name, p.email, p.score, p.joined, `hash-${p.id}`],
      );
    }
    for (const [index, name] of ODD.entries()) {
      await client.query(
        "INSERT INTO public.df_people (id, name, email, score, password_hash) VALUES ($1, $2, $3, 0, 'x')",
        [100 + index, name, `${index}@odd.test`],
      );
    }
  } finally {
    await client.end();
  }
}

async function connect(page: Page, database: TestDb, app: { link: string }): Promise<void> {
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Narrowing shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Narrowing shop" })).toBeVisible();
}

async function openTable(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("tab", { name: "Table details" }).click();
  await page.getByRole("button", { name }).first().click();
  await expect(page.getByRole("grid")).toBeVisible();
}

const grid = (page: Page) => page.getByRole("grid");
const panel = (page: Page) => page.getByRole("form", { name: "Add a filter" });
/** The error of the Data section (Next.js has a second, empty `alert` of its own for route changes). */
const readError = (page: Page) => page.getByRole("region", { name: "Data" }).getByRole("alert");
const chips = (page: Page) =>
  page.getByRole("list", { name: "Active filters" }).getByRole("listitem");
const filterButton = (page: Page) => page.getByRole("button", { name: /^Filter\b/ });

/**
 * The ids on the current page, in order, once it has loaded (the page being left stays on screen, dimmed,
 * while the next is read).
 */
async function shownIds(page: Page): Promise<string[]> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  return (await grid(page).locator("tbody tr td:first-child").allInnerTexts()).map((t) => t.trim());
}

/** Open the panel if it is closed, and add one condition. */
async function addFilter(
  page: Page,
  column: string,
  condition: string,
  value?: string,
): Promise<void> {
  if ((await panel(page).count()) === 0) await filterButton(page).click();
  await panel(page).getByLabel("Column").selectOption(column);
  await panel(page).getByLabel("Condition").selectOption({ label: condition });
  if (value !== undefined) await panel(page).getByLabel("Value").fill(value);
  await panel(page).getByRole("button", { name: "Add filter" }).click();
}

const idsWhere = (predicate: (p: Person) => boolean): string[] =>
  PEOPLE.filter(predicate).map((p) => String(p.id));

test.describe("filtering the rows", () => {
  test.beforeEach(async ({ page, app, database }) => {
    await plant(database);
    await connect(page, database, app);
    await openTable(page, /^df_people\b/);
    await page.getByLabel("Rows per page").selectOption("200");
  });

  test("adds a condition as a chip, narrows the rows, says so, and removes it again", async ({
    page,
  }) => {
    await expect
      .poll(() => shownIds(page).then((ids) => ids.length))
      .toBe(PEOPLE.length + ODD.length);

    await addFilter(page, "email", "contains", "ann");
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toContainText('email contains "ann"');
    await expect.poll(() => shownIds(page)).toEqual(idsWhere((p) => p.email.includes("ann")));
    await expect(page.getByText('Filtered: email contains "ann".')).toBeVisible();
    // The size estimate describes the whole table, so it is not shown while a filter is on.
    await expect(page.getByText(/^Page 1 · filtered/)).toBeVisible();
    await expect(filterButton(page)).toContainText("1");

    await page.getByRole("button", { name: 'Remove filter email contains "ann"' }).click();
    await expect(chips(page)).toHaveCount(0);
    await expect
      .poll(() => shownIds(page).then((ids) => ids.length))
      .toBe(PEOPLE.length + ODD.length);
    await expect(page.getByText(/Filtered:/)).toHaveCount(0);
    // The keyboard stays where it was: on the Filter button, not lost with the chip.
    await expect(filterButton(page)).toBeFocused();
  });

  test("offers each kind of column only the conditions it has, and not a hidden column until it is shown", async ({
    page,
  }) => {
    await filterButton(page).click();
    const conditions = async (column: string): Promise<string[]> => {
      await panel(page).getByLabel("Column").selectOption(column);
      return panel(page).getByLabel("Condition").locator("option").allInnerTexts();
    };
    expect(await conditions("email")).toContain("contains");
    expect(await conditions("email")).toContain("starts with");
    // A number: comparisons and NULL tests, but not text matching.
    const numeric = await conditions("score");
    expect(numeric).toContain("is at least");
    expect(numeric).not.toContain("contains");
    expect(numeric).not.toContain("starts with");
    // jsonb: it has no useful order, so only the tests for NULL.
    expect(await conditions("data")).toEqual(["is NULL", "is not NULL"]);

    // A hidden column is not offered; once shown, it is.
    await expect(
      panel(page).getByLabel("Column").locator("option[value='password_hash']"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Show the hidden column password_hash" }).click();
    await expect(
      panel(page).getByLabel("Column").locator("option[value='password_hash']"),
    ).toHaveCount(1);
  });

  test("combines conditions with a sort and pages through the result, each row once", async ({
    page,
  }) => {
    await page.getByLabel("Rows per page").selectOption("25");
    await addFilter(page, "score", "is at least", "5");
    await addFilter(page, "name", "contains", "a");
    await expect(chips(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Sort by score", exact: true }).click();
    await page.getByRole("button", { name: "Sort by score", exact: true }).click(); // descending

    const matching = PEOPLE.filter((p) => p.score >= 5 && p.name.includes("a")).sort(
      (a, b) => b.score - a.score || a.id - b.id,
    );
    const seen: string[] = [...(await shownIds(page))];
    for (let guard = 0; guard < 10; guard += 1) {
      const next = page.getByRole("button", { name: "Next" });
      if (await next.isDisabled()) break;
      await next.click();
      await expect(page.getByText(new RegExp(`^Page ${guard + 2}`))).toBeVisible();
      seen.push(...(await shownIds(page)));
    }
    expect(seen).toEqual(matching.map((p) => String(p.id)));
    expect(new Set(seen).size).toBe(matching.length);
    await expect(page.getByText(/Ordered by score \(descending, NULL first\)/)).toBeVisible();
    await expect(
      page.getByText(/Filtered: score is at least "5"; name contains "a"\./),
    ).toBeVisible();

    // Clearing starts again from the first page, in the same order.
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(chips(page)).toHaveCount(0);
    await expect(page.getByText(/^Page 1/)).toBeVisible();
  });

  test("stops at three conditions and says why", async ({ page }) => {
    await addFilter(page, "score", "is at least", "1");
    await addFilter(page, "score", "is at most", "12");
    await addFilter(page, "name", "contains", "a");
    await expect(chips(page)).toHaveCount(3);
    await expect(panel(page).getByRole("button", { name: "Add filter" })).toBeDisabled();
    await expect(panel(page).getByText(/At most 3 filters/)).toBeVisible();
    await page.getByRole("button", { name: /Remove filter score is at least/ }).click();
    await expect(chips(page)).toHaveCount(2);
    // There is room again: the limit message is gone, and a third condition can be added.
    await expect(panel(page).getByText(/At most 3 filters/)).toHaveCount(0);
    await addFilter(page, "email", "starts with", "ann");
    await expect(chips(page)).toHaveCount(3);
  });

  test("tests for NULL, with no value to type", async ({ page }) => {
    await filterButton(page).click();
    await panel(page).getByLabel("Column").selectOption("joined");
    await panel(page).getByLabel("Condition").selectOption({ label: "is NULL" });
    await expect(panel(page).getByLabel("Value")).toHaveCount(0);
    await panel(page).getByRole("button", { name: "Add filter" }).click();
    await expect(chips(page).first()).toContainText("joined is NULL");
    const expected = idsWhere((p) => p.joined === null);
    // The three odd rows have no date either.
    expected.push(...ODD.map((_, i) => String(100 + i)));
    await expect.poll(() => shownIds(page)).toEqual(expected);
  });

  test("matches text without case, and treats % and _ as plain characters", async ({ page }) => {
    await addFilter(page, "email", "contains", "ANN");
    await expect.poll(() => shownIds(page)).toEqual(idsWhere((p) => p.email.includes("ann")));
    await page.getByRole("button", { name: "Clear all" }).click();

    await addFilter(page, "name", "contains", "%");
    await expect.poll(() => shownIds(page)).toEqual(["100"]);
    await page.getByRole("button", { name: "Clear all" }).click();
    await addFilter(page, "name", "contains", "_");
    await expect.poll(() => shownIds(page)).toEqual(["101"]);
    await page.getByRole("button", { name: "Clear all" }).click();
    await addFilter(page, "name", "starts with", "back\\");
    await expect.poll(() => shownIds(page)).toEqual(["102"]);
  });

  test("says when nothing matches, and keeps the condition there to remove", async ({ page }) => {
    await addFilter(page, "name", "equals", "nobody-is-called-this");
    await expect(page.getByText("No rows match these filters.")).toBeVisible();
    await expect(grid(page)).toHaveCount(0);
    await expect(chips(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(grid(page)).toBeVisible();
  });

  test("a value that does not fit the column is refused in plain words, never with the database's message", async ({
    page,
  }) => {
    await addFilter(page, "score", "equals", "FORGED-NOT-A-NUMBER");
    const alert = readError(page);
    await expect(alert).toContainText("not valid for this column's type");
    await expect(alert).not.toContainText("invalid input syntax");
    await expect(alert).not.toContainText("FORGED-NOT-A-NUMBER");
    // The panel and the chip are still there to fix it.
    await expect(chips(page)).toHaveCount(1);
    await alert.getByRole("button", { name: "Remove the filters" }).click();
    await expect(alert).toHaveCount(0);
    await expect
      .poll(() => shownIds(page).then((ids) => ids.length))
      .toBe(PEOPLE.length + ODD.length);
  });

  test("a hidden column can be filtered once shown, and the condition goes when it is hidden again", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Show the hidden column password_hash" }).click();
    await addFilter(page, "password_hash", "starts with", "hash-1");
    await expect
      .poll(() => shownIds(page))
      .toEqual(idsWhere((p) => `hash-${p.id}`.startsWith("hash-1")));
    await page.getByRole("button", { name: "Hide the column password_hash again" }).click();
    await expect(chips(page)).toHaveCount(0);
    await expect(page.getByText(/^Page 1/)).toBeVisible();
    await expect
      .poll(() => shownIds(page).then((ids) => ids.length))
      .toBe(PEOPLE.length + ODD.length);
  });

  test("works from the keyboard", async ({ page }) => {
    await filterButton(page).focus();
    await page.keyboard.press("Enter"); // open the panel
    await panel(page).getByLabel("Column").selectOption("name");
    await panel(page).getByLabel("Condition").selectOption({ label: "starts with" });
    await panel(page).getByLabel("Value").fill("eve");
    await page.keyboard.press("Enter"); // submit from the value box
    await expect(chips(page)).toHaveCount(1);
    await expect.poll(() => shownIds(page)).toEqual(idsWhere((p) => p.name.startsWith("eve")));
  });

  test("keeps what was typed in the page only: nothing in the browser's storage, and another table starts clean", async ({
    page,
  }) => {
    const secret = "TYPED-CONDITION-VALUE";
    await addFilter(page, "name", "contains", secret);
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toContain(secret);
    expect(stored).not.toMatch(/contains|df_people/);
    await openTable(page, /^df_locked\b/);
    await expect(chips(page)).toHaveCount(0);
    await openTable(page, /^df_people\b/);
    await expect(chips(page)).toHaveCount(0);
  });
});

test("a read that takes too long is stopped with a plain sentence, and removing the filter brings the rows back", async ({
  page,
  app,
  database,
}) => {
  await plant(database);
  await connect(page, database, app);
  await openTable(page, /^df_locked\b/);
  await expect.poll(() => shownIds(page)).toEqual(["1", "2"]);

  // Another session holds the table, so the filtered read waits until the 5 second limit stops it.
  const locker = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await locker.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE public.df_locked IN ACCESS EXCLUSIVE MODE");
    await addFilter(page, "name", "equals", "a");
    const alert = readError(page);
    await expect(alert).toContainText(/longer than 5 seconds/, { timeout: 20_000 });
    await expect(alert).not.toContainText("canceling statement");
    await expect(chips(page)).toHaveCount(1);
  } finally {
    await locker.query("ROLLBACK").catch(() => undefined);
    await locker.end();
  }
  await readError(page).getByRole("button", { name: "Remove the filters" }).click();
  await expect.poll(() => shownIds(page)).toEqual(["1", "2"]);
});
