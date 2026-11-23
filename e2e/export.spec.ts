/**
 * Export of rows as a file, end to end (1.8.0, D4): the file that is downloaded (CSV with a byte order mark,
 * JSON with its notes, NDJSON), a hidden column left out and named, a formula defused, a table longer than
 * the limit cut with a line that says so, and axe on the dialog in both themes and on a phone.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

async function sql(database: TestDb, text: string): Promise<void> {
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

async function open(page: Page, link: string, database: TestDb, table: string): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("E shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect E shop" })).toBeVisible();
  await page.getByRole("tab", { name: "Table details" }).click();
  await page
    .getByRole("button", { name: new RegExp(`^${table}\\b`) })
    .first()
    .click();
  await expect(page.getByRole("grid")).toBeVisible();
}

async function exportAs(
  page: Page,
  format: string,
): Promise<{ text: string; bytes: Buffer; name: string }> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Export / });
  await dialog.getByLabel("Format").selectOption(format);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const file = await download;
  const bytes = readFileSync((await file.path())!);
  await expect(dialog.getByText(/^Saved /)).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  return { text: new TextDecoder().decode(bytes), bytes, name: file.suggestedFilename() };
}

async function axeOn(page: Page, name: string): Promise<void> {
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
    return axe.run(document.querySelector('[role="dialog"]') ?? document.body, {
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

test.describe("export", () => {
  test.beforeEach(async ({ page, app, database }) => {
    await sql(
      database,
      `CREATE TABLE public.x_orders (id integer PRIMARY KEY, name text, note text, api_token text);
       INSERT INTO public.x_orders VALUES
         (1, 'Ann', '=HYPERLINK("http://x")', 'tok-1'),
         (2, 'Bo, "the" builder', NULL, 'tok-2'),
         (3, 'Cy', '', 'tok-3');
       INSERT INTO public.x_orders SELECT i, 'row ' || i, 'n' || i, 'tok' FROM generate_series(4, 120) i;`,
    );
    await open(page, app.link, database, "x_orders");
  });

  test("a CSV file: byte order mark, header, hidden column left out, formula defused, NULL kept apart", async ({
    page,
  }) => {
    const file = await exportAs(page, "csv");
    expect([...file.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(file.name).toMatch(/^x_orders-\d{8}-\d{6}\.csv$/);
    const lines = file.text.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe("id,name,note");
    // A formula gets an apostrophe in front of it (and the quotes inside it are doubled).
    expect(lines).toContain(`1,Ann,"'=HYPERLINK(""http://x"")"`);
    expect(lines).toContain('2,"Bo, ""the"" builder",');
    expect(lines).toContain("3,Cy,");
    expect(lines.filter((l) => /^\d+,/.test(l))).toHaveLength(120);
    expect(file.text).not.toContain("tok");
    // Not cut, and no notes unless asked for.
    expect(file.text).not.toContain("#");
  });

  test("a JSON file with its notes, and the column left out is named", async ({ page }) => {
    const file = await exportAs(page, "json");
    const parsed = JSON.parse(file.text);
    expect(parsed.rows).toHaveLength(120);
    expect(parsed.rows[1]).toEqual({ id: "2", name: 'Bo, "the" builder', note: null });
    expect(parsed._meta).toMatchObject({
      source: "public.x_orders",
      rows: 120,
      cut: null,
      columnsLeftOut: ["api_token"],
    });
    // The notes name the column, but no value of it is in the file.
    expect(file.text).not.toMatch(/tok-\d|"tok"/);
  });

  test("an NDJSON file is one object per line", async ({ page }) => {
    const file = await exportAs(page, "ndjson");
    const lines = file.text.trim().split("\n");
    expect(lines).toHaveLength(120);
    expect(JSON.parse(lines[0]!)).toEqual({ id: "1", name: "Ann", note: '=HYPERLINK("http://x")' });
  });

  test("passes axe in light, in dark and on a phone", async ({ page }) => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /^Export / })).toBeVisible();
    await axeOn(page, "the export dialog (light)");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await axeOn(page, "the export dialog (dark)");
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByRole("dialog", { name: /^Export / })).toBeVisible();
    await axeOn(page, "the export dialog (phone)");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("a table longer than the limit is cut at 100,000 rows, and the file says so", async ({
  page,
  app,
  database,
}) => {
  await sql(
    database,
    `CREATE TABLE public.x_big (id integer PRIMARY KEY, v text);
     INSERT INTO public.x_big SELECT i, 'v' || i FROM generate_series(1, 100050) i;`,
  );
  await open(page, app.link, database, "x_big");
  const file = await exportAs(page, "csv");
  const lines = file.text.replace(/^\uFEFF/, "").split("\r\n");
  expect(lines.filter((l) => /^\d+,v\d+$/.test(l))).toHaveLength(100_000);
  expect(file.text).toContain(
    "# This file was cut at the limit of 100,000 rows. The table has more.",
  );
});
