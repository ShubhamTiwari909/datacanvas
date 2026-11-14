/**
 * The Objects tab and snapshot comparison of objects, end to end: objects are
 * planted in a throwaway database, shown in the tab, saved in a snapshot, and
 * the changes made afterwards must show up in the comparison.
 */
import pg from "pg";
import { expect, test } from "./fixtures";

test("objects are listed, saved in a snapshot and compared", async ({ page, app, database }) => {
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
      CREATE TYPE public.e2e_mood AS ENUM ('sad', 'happy');
      CREATE FUNCTION public.e2e_add(a integer) RETURNS integer
        LANGUAGE sql IMMUTABLE AS $$ SELECT a + 1 $$;
      CREATE VIEW public.e2e_active AS SELECT id, email FROM public.users;
      CREATE TABLE public.e2e_locked (id integer PRIMARY KEY);
      ALTER TABLE public.e2e_locked ENABLE ROW LEVEL SECURITY;
    `);

    await page.goto(app.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("Objects shop");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect Objects shop" })).toBeVisible();

    // An item is opened by clicking its title (its details hold the same name again, as a link).
    const open = (title: string) =>
      page.locator("summary").getByText(title, { exact: true }).click();

    // ---- the Objects tab
    await page.getByRole("tab", { name: "Objects" }).click();
    await expect(page.getByText("Definitions and settings only.")).toBeVisible();

    const viewItem = page.locator("li", {
      has: page.getByText("public.e2e_active", { exact: true }),
    });
    await viewItem.locator("summary").click();
    await expect(viewItem.getByText("FROM users")).toBeVisible();
    // What the view reads is a link that shows the table on the canvas.
    await expect(
      viewItem.getByRole("button", { name: "Show public.users on the canvas" }),
    ).toBeVisible();

    await page.getByRole("tab", { name: /^Types/ }).click();
    await open("public.e2e_mood");
    await expect(page.getByText("sad", { exact: true })).toBeVisible();
    await expect(page.getByText("happy", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: /^Functions/ }).click();
    await open("public.e2e_add(a integer)");
    await expect(page.getByText("CREATE OR REPLACE FUNCTION public.e2e_add")).toBeVisible();

    await page.getByRole("tab", { name: /^Policies/ }).click();
    await open("public.e2e_locked");
    await expect(page.getByText(/there are no policies/)).toBeVisible();

    // The filter narrows a list.
    await page.getByRole("tab", { name: /^Views/ }).click();
    await page.getByRole("textbox", { name: /Filter views/ }).fill("zzz-nothing");
    await expect(page.getByText("Nothing matches the filter.")).toBeVisible();

    // ---- a snapshot records them
    await page.getByRole("tab", { name: "Snapshots" }).click();
    await page.getByLabel("Name (optional)").fill("Before changes");
    await page.getByRole("button", { name: "Take snapshot" }).click();
    await expect(page.getByText("Snapshot saved.")).toBeVisible();
    await expect(page.getByText(/\d+ other objects?/)).toBeVisible();

    // ---- change the database, then compare the snapshot with the live database
    await client.query(`
      CREATE FUNCTION public.e2e_new() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
      DROP VIEW public.e2e_active;
      CREATE POLICY e2e_p ON public.e2e_locked USING (true);
    `);
    await page.getByRole("button", { name: "Compare" }).click();

    const functions = page.getByRole("region", { name: "Functions" });
    await expect(functions.getByText("public.e2e_new()")).toBeVisible();
    await expect(functions.getByText("added")).toBeVisible();
    const views = page.getByRole("region", { name: "Views" });
    await expect(views.getByText("public.e2e_active")).toBeVisible();
    await expect(views.getByText("removed")).toBeVisible();
    await expect(page.getByRole("region", { name: "Policies" })).toBeVisible();
    // Tables did not change, and the object kinds that did not change are not listed.
    await expect(page.getByRole("region", { name: "Types" })).toHaveCount(0);

    // Deleting the snapshot the comparison used clears that comparison.
    await page.getByRole("button", { name: "Delete Before changes" }).click();
    await page.getByRole("button", { name: "Confirm deleting Before changes" }).click();
    await expect(page.getByText("Snapshot deleted.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Functions" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Views" })).toHaveCount(0);
  } finally {
    await client.end();
  }
});
