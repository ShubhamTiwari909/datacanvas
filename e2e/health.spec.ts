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

test("health reports type mismatches, unused indexes and naming oddities", async ({
  page,
  app,
  database,
}) => {
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
      CREATE TABLE public.hq_parent (id bigint PRIMARY KEY);
      CREATE TABLE public.hq_child (
        id integer PRIMARY KEY,
        parent_id integer NOT NULL REFERENCES public.hq_parent (id)  -- integer -> bigint
      );
      CREATE INDEX hq_child_parent_id ON public.hq_child (parent_id);
      CREATE TABLE public.hq_idle (id integer PRIMARY KEY, label text);
      CREATE INDEX hq_idle_label ON public.hq_idle (label);          -- never used
      -- Enough foreign keys named *_id for that to be this database's style, and one that is not.
      CREATE TABLE public.hq_a (id integer PRIMARY KEY, user_id integer REFERENCES public.users (id));
      CREATE TABLE public.hq_b (id integer PRIMARY KEY, user_id integer REFERENCES public.users (id));
      CREATE TABLE public.hq_c (id integer PRIMARY KEY, owner integer REFERENCES public.users (id));
      -- A name that needs quoting in a database of plain names.
      CREATE TABLE public."Hq Camel" (id integer PRIMARY KEY, "createdAt" timestamptz);
    `);

    await page.goto(app.link);
    await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
    await page.getByLabel("Connection name").fill("Health extras");
    await page.getByRole("tab", { name: /connection string/i }).click();
    await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
    await page.getByRole("button", { name: /^Connect$/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect Health extras" })).toBeVisible();

    await page.getByRole("tab", { name: "Health" }).click();
    await expect(page.getByText(/Checked \d+ tables?/)).toBeVisible();
    await expect(page.getByText(/Index usage counters/)).toBeVisible();

    // Type mismatch: a warning, with the statement that would fix it.
    const mismatch = page.getByRole("region", { name: "Foreign keys whose column types differ" });
    await expect(
      mismatch.getByText("hq_child.parent_id (integer) references hq_parent.id (bigint)", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      mismatch.getByText('ALTER TABLE "public"."hq_child" ALTER COLUMN "parent_id" TYPE bigint;'),
    ).toBeVisible();

    // Unused indexes are an open section; the naming checks are notes (folded groups, their text is still in the page).
    const unused = page.getByRole("region", { name: "Indexes that have not been used" });
    await expect(unused.getByText(/Index hq_idle_label on hq_idle/)).toHaveCount(1);
    await expect(unused.getByText('DROP INDEX CONCURRENTLY "public"."hq_idle_label";')).toHaveCount(
      1,
    );
    // The primary keys and the supporting index of the foreign key are not listed as unused.
    await expect(unused.getByText(/Index hq_idle_pkey/)).toHaveCount(0);

    const naming = page.getByRole("group", { name: "Names that break the database's own style" });
    await expect(naming.getByText(/table "Hq Camel"/)).toHaveCount(1);
    await expect(naming.getByText(/column "createdAt"/)).toHaveCount(1);

    const fkNames = page.getByRole("group", {
      name: "Foreign key columns not named like the others",
    });
    await expect(fkNames.getByText(/hq_c\.owner references users/)).toHaveCount(1);
  } finally {
    await client.end();
  }
});
