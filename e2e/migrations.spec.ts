/**
 * The Migrations tab (1.7.0, M4): from a comparison to a script. Make a snapshot, change the
 * database, open the migration from the comparison, confirm a rename, leave a change out, confirm
 * a destructive step, read the script and the rollback, download it; then axe-core in both
 * themes, and a phone.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.MIGRATIONS_DIR ?? path.join(here, "../test-results/migrations");
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

/** Connect, take a snapshot "Before", change the database, and open the migration from the comparison. */
async function openMigration(page: Page, link: string, database: TestDb) {
  await admin(
    database,
    `CREATE TABLE public.m_old (id int PRIMARY KEY, name text);
     CREATE TABLE public.m_keep (id int PRIMARY KEY, qty int);
     CREATE TABLE public.m_gone (id int);
     INSERT INTO public.m_gone VALUES (1), (2);`,
  );
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Migration shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("tab", { name: "Snapshots" }).click();
  await page.getByLabel("Name (optional)").fill("Before");
  await page.getByRole("button", { name: "Take snapshot" }).click();
  await expect(page.getByText("Snapshot saved.")).toBeVisible();

  await admin(
    database,
    `ALTER TABLE public.m_keep ADD COLUMN note text;
     DROP TABLE public.m_gone;
     ALTER TABLE public.m_old RENAME TO m_fresh;`,
  );
  await page.getByRole("button", { name: "Compare" }).click();
  await page.getByRole("button", { name: "Generate a migration from this comparison" }).click();
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
}

const script = (page: Page) => page.getByLabel("Script", { exact: true });

async function axeOn(page: Page, name: string): Promise<void> {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    const axe = (
      window as unknown as { axe: { run: (c: Element, o: object) => Promise<AxeResult> } }
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

test("makes a migration from a comparison: renames, leaving out, destructive steps, the text", async ({
  page,
  app,
  database,
}) => {
  await openMigration(page, app.link, database);

  // The plan opens from the comparison, with a verdict and counts.
  await expect(page.getByRole("status").filter({ hasText: /steps? to make/ })).toBeVisible();
  await expect(page.getByText(/2 destroy data \(2 not confirmed\)/)).toBeVisible();

  // Without confirming a rename, it is a drop and an add.
  await expect(page.getByLabel(/Include step s\d+: Drops the table m_old/)).toBeVisible();
  await expect(page.getByLabel(/Include step s\d+: Creates the table m_fresh/)).toBeVisible();

  // The destructive step is written commented out until it is confirmed.
  await expect(script(page)).toContainText('-- DROP TABLE "public"."m_gone";');
  await expect(script(page)).not.toContainText(/^DROP TABLE "public"."m_gone";/m);
  await page
    .getByLabel(/Confirm s\d+: I know this destroys data/)
    .first()
    .check();
  await expect(script(page)).toContainText(/^DROP TABLE "public"."m_gone";/m);

  // A rename is offered with its evidence, and is a rename once confirmed.
  await expect(page.getByRole("heading", { name: /Possible renames \(1\)/ })).toBeVisible();
  await expect(page.getByText(/Both have the same 2 columns/)).toBeVisible();
  await page.getByLabel(/Rename the table m_old to m_fresh/).check();
  await expect(
    page.getByLabel(/Include step s\d+: Renames the table m_old to m_fresh/),
  ).toBeVisible();
  await expect(page.getByLabel(/Include step s\d+: Drops the table m_old/)).toHaveCount(0);
  await expect(script(page)).toContainText('ALTER TABLE "public"."m_old" RENAME TO "m_fresh";');

  // Leaving a step out takes it from the script.
  await expect(script(page)).toContainText('ADD COLUMN "note"');
  await page.getByLabel(/Include step s\d+: Adds the column note/).uncheck();
  await expect(script(page)).not.toContainText('ADD COLUMN "note"');

  // The rollback undoes in reverse and is a text of its own.
  await page.getByRole("tab", { name: "Rollback" }).click();
  await expect(page.getByLabel("Rollback", { exact: true })).toContainText(
    'ALTER TABLE "public"."m_fresh" RENAME TO "m_old";',
  );

  // The notes say what was not compared.
  await page.getByRole("tab", { name: /^Notes/ }).click();
  await expect(page.getByText(/Not compared, so not in this migration/)).toBeVisible();

  // Export: each format is files with a name made from the clock and the name given.
  await page.getByLabel("Name of the migration").fill("Add the shop!");
  await page.getByLabel("Format").selectOption("flyway");
  const names = page.getByRole("region", { name: "Export" }).locator("code");
  await expect(names).toHaveText([/^V\d{14}__add_the_shop\.sql$/, /^U\d{14}__add_the_shop\.sql$/]);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Download V\d{14}__add_the_shop\.sql$/ }).click();
  const file = await download;
  const content = readFileSync((await file.path())!, "utf8");
  expect(content).toContain("Read it before you run it");
  expect(content).toContain('ALTER TABLE "public"."m_old" RENAME TO "m_fresh";');
  expect(content).not.toContain("BEGIN;");

  await page.getByLabel("Format").selectOption("goose");
  await expect(names).toHaveText([/^\d{14}_add_the_shop\.sql$/]);
  await page.getByText(/^Show \d{14}_add_the_shop\.sql$/).click();
  await expect(page.getByRole("region", { name: "Export" }).locator("pre")).toContainText(
    "-- +goose Up",
  );

  // From and To swap, and a new plan is made on request.
  await page.getByRole("button", { name: "Swap From and To" }).click();
  await page.getByRole("button", { name: "Generate migration" }).click();
  await expect(page.getByLabel(/Include step s\d+: Drops the column note/)).toBeVisible();
});

test("passes axe in light and dark, and fits a phone", async ({ page, app, database }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openMigration(page, app.link, database);
  mkdirSync(shots, { recursive: true });

  for (const theme of ["Light", "Dark"] as const) {
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: theme }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.screenshot({
      path: path.join(shots, `migrations-${theme.toLowerCase()}.png`),
      fullPage: true,
    });
    await axeOn(page, `the migration (${theme.toLowerCase()})`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "no sideways scrolling on a phone").toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join(shots, "migrations-phone.png"), fullPage: true });
  await axeOn(page, "the migration (phone)");
});
