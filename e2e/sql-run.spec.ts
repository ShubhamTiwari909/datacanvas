/**
 * The SQL runner's route in the packaged app (1.6.0, S1; decision 141), called from the
 * browser as the SQL view will: a read, a refused write, the viewing switch, one at a time,
 * and cancelling by aborting the request, which must cancel the statement in the database
 * (the part only a real server can show).
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, type TestDb } from "./fixtures";

async function admin<Row extends Record<string, unknown> = Record<string, unknown>>(
  database: TestDb,
  text: string,
): Promise<Row[]> {
  const c = new pg.Client({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.name,
  });
  await c.connect();
  try {
    return (await c.query(text)).rows as Row[];
  } finally {
    await c.end();
  }
}

async function connect(
  page: Page,
  link: string,
  database: TestDb,
  dataAccess: boolean,
): Promise<string> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Sql shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  if (dataAccess) await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Sql shop" })).toBeVisible();
  return page.evaluate(async () => {
    const response = await fetch("/api/connections");
    const body = (await response.json()) as { connections: { id: string }[] };
    return body.connections[0]!.id;
  });
}

/** Post a statement from the page, as the browser does; `abortAfterMs` aborts the request. */
function run(page: Page, id: string, text: string, abortAfterMs?: number) {
  return page.evaluate(
    async ({ id, text, abortAfterMs }) => {
      const controller = new AbortController();
      if (abortAfterMs !== undefined) setTimeout(() => controller.abort(), abortAfterMs);
      try {
        const response = await fetch(`/api/connections/${id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, timeoutMs: 60_000 }),
          signal: controller.signal,
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      } catch (error) {
        return { status: 0, body: { aborted: (error as Error).name } };
      }
    },
    { id, text, abortAfterMs },
  );
}

test("runs a read, refuses a write, and needs the viewing switch", async ({
  page,
  app,
  database,
}) => {
  await admin(
    database,
    "CREATE TABLE public.s_items (id int PRIMARY KEY, v text); INSERT INTO public.s_items VALUES (1, 'one'); CREATE FUNCTION public.s_writer() RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM public.s_items; RETURN 1; END $$",
  );
  const id = await connect(page, app.link, database, true);

  const read = await run(page, id, "SELECT id, v FROM public.s_items ORDER BY id");
  expect(read.status).toBe(200);
  expect(read.body.result.columns).toEqual([
    { name: "id", dataType: "integer" },
    { name: "v", dataType: "text" },
  ]);
  expect(read.body.result.rows).toEqual([["1", "one"]]);

  // A write is refused by its first word; one that gets past that (a function that deletes) by the database.
  const write = await run(page, id, "DELETE FROM public.s_items");
  expect(write.body.failure.code).toBe("not_allowed");
  const refused = await run(page, id, "DROP TABLE public.s_items");
  expect(refused.body.failure.code).toBe("not_allowed");
  const sneaky = await run(page, id, "SELECT public.s_writer()");
  expect(sneaky.body.failure.code).toBe("25006");
  const several = await run(page, id, "SELECT 1; DELETE FROM public.s_items");
  expect(several.body.failure.code).toBe("42601");
  expect(await admin(database, "SELECT count(*)::int AS n FROM public.s_items")).toEqual([
    { n: 1 },
  ]);
});

test("is refused while viewing table data is off", async ({ page, app, database }) => {
  const id = await connect(page, app.link, database, false);
  const result = await run(page, id, "SELECT 1");
  expect(result.status).toBe(403);
  expect(result.body.error.code).toBe("data_access_disabled");
});

test("runs one statement at a time, and aborting the request cancels it in the database", async ({
  page,
  app,
  database,
}) => {
  const id = await connect(page, app.link, database, true);
  const backends = async () =>
    (
      await admin<{ n: number }>(
        database,
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'DataCanvas SQL'",
      )
    )[0]!.n;

  const slow = run(page, id, "SELECT pg_sleep(30)", 1500);
  await expect.poll(backends, { timeout: 5000 }).toBe(1);
  const second = await run(page, id, "SELECT 1");
  expect(second.status).toBe(429);
  expect(second.body.error.code).toBe("sql_busy");

  expect((await slow).body.aborted).toBe("AbortError");
  // The browser let go, and the server cancelled the statement and closed its connection.
  await expect.poll(backends, { timeout: 10_000 }).toBe(0);
  // The connection is free again.
  expect((await run(page, id, "SELECT 1")).status).toBe(200);
});
