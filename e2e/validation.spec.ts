/**
 * Validation, end to end (1.8.0, D3): "Validate" in the edit and add-row forms says whether the database
 * would accept the values without writing anything, and the Migrations tab's pre-flight says which steps
 * would fail on the data. axe in both themes and on a phone.
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

async function sql<Row extends Record<string, unknown> = Record<string, unknown>>(
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

async function connect(page: Page, link: string, database: TestDb): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("V shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByLabel("Allow viewing table data").check();
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect V shop" })).toBeVisible();
}

/** axe on the page, or on the open dialog only (the grid behind it has its own known findings). */
async function axeOn(page: Page, name: string, inDialog = false): Promise<void> {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async (scoped) => {
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
    return axe.run((scoped && document.querySelector('[role="dialog"]')) || document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  }, inDialog);
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

test.describe("Validate in the row forms", () => {
  test.beforeEach(async ({ page, writableApp, database }) => {
    await sql(
      database,
      `CREATE TABLE public.v_items (
         id integer PRIMARY KEY, name text NOT NULL,
         qty integer CONSTRAINT qty_not_negative CHECK (qty >= 0), email text UNIQUE);
       INSERT INTO public.v_items VALUES (1, 'Ann', 1, 'ann@x.test'), (2, 'Bo', 2, 'bo@x.test');`,
    );
    await connect(page, writableApp.link, database);
    await page.getByRole("switch", { name: "Allow changes to V shop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Database name" }).fill(database.name);
    await dialog.getByRole("button", { name: "Allow changes" }).click();
    await expect(page.getByText("Writes on")).toBeVisible();
    await page.getByRole("tab", { name: "Table details" }).click();
    await page
      .getByRole("button", { name: /^v_items\b/ })
      .first()
      .click();
    await expect(page.getByRole("grid")).toBeVisible();
  });

  test("an edit is checked without writing, and the answer goes away when a value changes", async ({
    page,
    database,
  }) => {
    await page.getByRole("button", { name: "Edit row 1" }).click();
    const form = page.getByRole("dialog", { name: /Edit a row of/ });
    await expect(form.getByRole("button", { name: "Validate" })).toBeDisabled();

    await form.getByRole("textbox", { name: "qty", exact: true }).fill("-5");
    await form.getByRole("button", { name: "Validate" }).click();
    await expect(form.getByRole("status", { name: "Check of the values" })).toContainText(
      "The database would refuse this",
    );
    await expect(form.getByRole("status", { name: "Check of the values" })).toContainText(
      "qty_not_negative",
    );

    // The answer belongs to the values it was asked about.
    await form.getByRole("textbox", { name: "qty", exact: true }).fill("7");
    await expect(form.getByText("The database would refuse this")).toHaveCount(0);
    await form.getByRole("button", { name: "Validate" }).click();
    await expect(form.getByText(/No problems found/)).toBeVisible();

    // Another row's email.
    await form.getByRole("textbox", { name: "email", exact: true }).fill("bo@x.test");
    await form.getByRole("button", { name: "Validate" }).click();
    await expect(form.getByRole("status", { name: "Check of the values" })).toContainText(
      "A row with this value already exists",
    );
    await expect(form.getByRole("status", { name: "Check of the values" })).toContainText(
      "v_items_email_key",
    );

    // Nothing was written by any of it.
    expect(await sql(database, "SELECT qty, email FROM public.v_items WHERE id = 1")).toEqual([
      { qty: 1, email: "ann@x.test" },
    ]);
  });

  test("a new row is checked for what is missing, and passes axe in both themes and on a phone", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Add row" }).click();
    const form = page.getByRole("dialog", { name: /Add a row to/ });
    await form.getByRole("textbox", { name: "Value for id" }).fill("1");
    await form.getByRole("button", { name: "Validate" }).click();
    const report = form.getByRole("status", { name: "Check of the values" });
    await expect(report).toContainText("The database would refuse this");
    // An empty field is the empty string, not NULL: only the key collides.
    await expect(report).toContainText('"v_items_pkey"');
    await expect(report).toContainText("A row with this value already exists");
    await axeOn(page, "the validation report (light)", true);

    await form.getByRole("button", { name: "Cancel" }).click();
    for (const theme of ["Dark"] as const) {
      await page.getByRole("button", { name: /^Theme:/ }).click();
      await page.getByRole("menuitemradio", { name: theme }).click();
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Add row" }).click();
    await form.getByRole("textbox", { name: "Value for id" }).fill("1");
    await form.getByRole("button", { name: "Validate" }).click();
    await expect(form.getByRole("status", { name: "Check of the values" })).toContainText(
      "would refuse",
    );
    await axeOn(page, "the validation report (dark)", true);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(form.getByRole("status", { name: "Check of the values" })).toContainText(
      "would refuse",
    );
    await axeOn(page, "the validation report (phone)", true);
  });
});

test("the Migrations tab says which steps will fail on the data", async ({
  page,
  app,
  database,
}) => {
  // The structure to go TO is a snapshot of tables with the constraints; the database then loses the
  // constraints and gets rows that would break them.
  await sql(
    database,
    `CREATE TABLE public.p_parent (id int PRIMARY KEY);
     INSERT INTO public.p_parent VALUES (1);
     CREATE TABLE public.p_child (id int NOT NULL, parent_id int REFERENCES public.p_parent (id), tag text, CONSTRAINT p_child_tag_key UNIQUE (tag));`,
  );
  await connect(page, app.link, database);
  await page.getByRole("tab", { name: "Snapshots" }).click();
  await page.getByLabel("Name (optional)").fill("Target");
  await page.getByRole("button", { name: "Take snapshot" }).click();
  await expect(page.getByText("Snapshot saved.")).toBeVisible();
  await sql(
    database,
    `ALTER TABLE public.p_child DROP CONSTRAINT p_child_tag_key;
     ALTER TABLE public.p_child DROP CONSTRAINT p_child_parent_id_fkey;
     ALTER TABLE public.p_child ALTER COLUMN id DROP NOT NULL;
     INSERT INTO public.p_child VALUES (1, 1, 'dup'), (NULL, 99, 'dup'), (3, 98, 'x');`,
  );

  await page.getByRole("tab", { name: "Migrations" }).click();
  await page
    .getByLabel("From", { exact: true })
    .selectOption({ label: `Live: V shop (${database.name})` });
  await page.getByLabel("To", { exact: true }).selectOption({ label: "Target" });
  await page.getByRole("button", { name: "Generate migration" }).click();
  await expect(page.getByRole("heading", { name: "Will it work on your data?" })).toBeVisible();

  await page.getByRole("button", { name: "Check against the data" }).click();
  await expect(page.getByText("1 row has NULL in id, so this step would fail.")).toBeVisible();
  await expect(page.getByText(/1 value is shared by more than one row of \(tag\)/)).toBeVisible();
  await expect(
    page.getByText(/2 rows point at a row that does not exist in p_parent/),
  ).toBeVisible();
  await expect(page.getByText("Will fail on your data").first()).toBeVisible();
  await axeOn(page, "the pre-flight");
});
