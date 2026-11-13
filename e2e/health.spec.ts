/**
 * The Health tab, end to end: problems are planted in a throwaway database and
 * the tab must report exactly those, with usable SQL, and jump to the canvas.
 */
import pg from "pg";
import { expect, test } from "./fixtures";

test("health reports planted problems and jumps to the canvas", async ({ page, app, database }) => {
  const client = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await client.connect();
  await client.query(`
    CREATE TABLE public.hp_parent (id integer PRIMARY KEY);
    CREATE TABLE public.hp_loose (a integer, b text);                       -- no primary key
    CREATE TABLE public.hp_child (id integer PRIMARY KEY, parent_id integer REFERENCES public.hp_parent (id));
    CREATE TABLE public.hp_dupes (id integer PRIMARY KEY, x integer);
    CREATE INDEX hp_dupes_x_1 ON public.hp_dupes (x);
    CREATE INDEX hp_dupes_x_2 ON public.hp_dupes (x);
    CREATE TABLE public.hp_fine (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.hp_parent (id));
    CREATE INDEX hp_fine_parent ON public.hp_fine (parent_id);
  `);
  await client.end();

  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Health shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Health shop" })).toBeVisible();

  await page.getByRole("tab", { name: "Health" }).click();
  await expect(page.getByText(/Checked \d+ tables?/)).toBeVisible();

  const noPk = page.getByRole("region", { name: "Tables without a primary key" });
  await expect(noPk.getByRole("button", { name: "Show hp_loose on the canvas" })).toBeVisible();
  await expect(noPk.getByRole("button", { name: "Show hp_fine on the canvas" })).toHaveCount(0);

  const fk = page.getByRole("region", { name: "Foreign keys without a supporting index" });
  await expect(fk.getByRole("button", { name: "Show hp_child on the canvas" })).toBeVisible();
  await expect(fk.getByText('CREATE INDEX ON "public"."hp_child" ("parent_id");')).toBeVisible();
  // The table with its index is not reported.
  await expect(fk.getByRole("button", { name: "Show hp_fine on the canvas" })).toHaveCount(0);

  const dupes = page.getByRole("region", { name: "Duplicate indexes" });
  await expect(dupes.getByText(/hp_dupes_x_1, hp_dupes_x_2/)).toBeVisible();

  // A finding jumps to the canvas with that table on it.
  await noPk.getByRole("button", { name: "Show hp_loose on the canvas" }).click();
  await expect(page.getByRole("tab", { name: "Canvas", selected: true })).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id*="hp_loose"]').first()).toBeVisible();
});
