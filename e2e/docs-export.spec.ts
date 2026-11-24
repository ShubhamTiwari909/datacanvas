/**
 * Documentation and diagram exports (1.10.0, V4; docs/insight-release-plan.md, section 7; decision 166): the structure
 * of the database as Markdown, Mermaid, DBML or PlantUML, made in the browser. It works with "Allow viewing table
 * data" OFF, holds no row and no value, and a table with a hostile name does not break the file. axe in both themes.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test, settleForAxe, type TestDb } from "./fixtures";

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

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

async function open(page: Page, link: string, database: TestDb) {
  await admin(
    database,
    `CREATE TABLE public."odd ""name"" | x" ("c|d" int PRIMARY KEY, "line
break" text);
     INSERT INTO public."odd ""name"" | x" VALUES (1, 'MARKER-ROW');`,
  );
  await page.goto(link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Docs shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  // Allow viewing table data stays OFF: the structure is all this reads.
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Docs shop" })).toBeVisible();
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Export documentation" }).click();
  await expect(page.getByRole("dialog", { name: "Export documentation" })).toBeVisible();
}

async function download(page: Page, format: RegExp): Promise<{ name: string; text: string }> {
  // The dialog closes when the file is saved: open it again for the next file.
  if ((await page.getByRole("dialog", { name: "Export documentation" }).count()) === 0) {
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("button", { name: "Export documentation" }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Export documentation" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: format }).check();
  const waiting = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Save file" }).click();
  const file = await waiting;
  const path = await file.path();
  // The dialog closes once the file is saved.
  await expect(dialog).toHaveCount(0);
  return { name: file.suggestedFilename(), text: readFileSync(path, "utf8") };
}

test.describe("documentation exports", () => {
  test("Markdown: a data dictionary with the tables, the keys and the references, and no value of any table", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database);
    const { name, text } = await download(page, /Markdown data dictionary/);
    expect(name).toMatch(/^Docs_shop-data-dictionary\.md$/);
    expect(text).toContain("# Docs shop: data dictionary");
    expect(text).toContain("### orders");
    expect(text).toContain("| id | integer | no |");
    expect(text).toContain("→ public.users");
    expect(text).not.toContain("MARKER-ROW");
    // The hostile table is a heading of its own and its cells are intact.
    expect(text).toMatch(/^### odd "name" \\\| x$/m);
  });

  test("Mermaid, DBML and PlantUML: each parses as its own shape, with the hostile names kept inside their quotes", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database);
    const mermaid = await download(page, /Mermaid diagram/);
    expect(mermaid.name).toMatch(/\.mmd$/);
    expect(mermaid.text.startsWith("erDiagram\n")).toBe(true);
    expect(mermaid.text).toContain('"public.orders" {');
    expect(mermaid.text).toContain('"public.users" ||--o{ "public.orders"');
    expect(mermaid.text).not.toContain("MARKER-ROW");

    const dbml = await download(page, /DBML/);
    expect(dbml.name).toMatch(/\.dbml$/);
    expect(dbml.text).toContain('Table "public"."orders" {');
    expect(dbml.text).toMatch(
      /^Ref "[^"\n]+": "public"\."orders"\."user_id" > "public"\."users"\."id"$/m,
    );
    expect(dbml.text).toContain('Table "public"."odd \'name\' | x" {');

    const plant = await download(page, /PlantUML diagram/);
    expect(plant.name).toMatch(/\.puml$/);
    expect(plant.text.startsWith("@startuml\n")).toBe(true);
    expect(plant.text.trimEnd().endsWith("@enduml")).toBe(true);
    expect(plant.text.match(/^@enduml$/gm)).toHaveLength(1);
  });

  test("one schema only, and the canvas export dialog leads here", async ({
    page,
    app,
    database,
  }) => {
    await open(page, app.link, database);
    const dialog = page.getByRole("dialog", { name: "Export documentation" });
    await dialog.getByLabel("What to describe").selectOption("public");
    const { text } = await download(page, /Mermaid diagram/);
    expect(text).toContain('"public.orders"');
    await page.getByRole("tab", { name: "Canvas" }).click();
    await page.getByRole("button", { name: "Add all tables of public to the canvas" }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    // Nothing may stick out of the dialog: the notice and all four buttons stay inside its box (it once fell back to the
    // narrowest size and the footer overflowed). Measured once the dialog has stopped zooming in, all in one pass.
    const exportDialog = page.getByRole("dialog", { name: "Export diagram" });
    await expect(exportDialog).toBeVisible();
    // The same check at two widths: as it is, and squeezed (fonts differ between machines, and on a wider font four buttons
    // do not fit in one row: they must wrap, not run off the left edge).
    const outsideAt = (width: string | null) =>
      exportDialog.evaluate(async (root, maxWidth) => {
        const settle = async (): Promise<void> => {
          // The dialog animates (zoom, and a width that changes): wait for a frame, then for every animation to end.
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          await Promise.all(
            root.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)),
          );
        };
        await settle();
        (root as HTMLElement).style.maxWidth = maxWidth ?? "";
        await settle();
        const box = root.getBoundingClientRect();
        const bad: string[] = [];
        for (const el of root.querySelectorAll("button, p, [data-slot=dialog-footer]")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.left < box.left - 1 || r.right > box.right + 1) {
            bad.push(`${el.tagName} "${(el.textContent ?? "").slice(0, 30)}" sticks out`);
          }
        }
        return bad;
      }, width);
    expect(await outsideAt(null)).toEqual([]);
    expect(await outsideAt("440px")).toEqual([]);
    await exportDialog.evaluate((root) => ((root as HTMLElement).style.maxWidth = ""));
    for (const name of [
      /^Cancel$/,
      /^Documentation and diagram text/,
      /Save as SVG/,
      /Save as PNG/,
    ]) {
      await expect(exportDialog.getByRole("button", { name })).toBeVisible();
    }
    await page.getByRole("button", { name: /^Documentation and diagram text/ }).click();
    await expect(page.getByRole("dialog", { name: "Export documentation" })).toBeVisible();
  });

  test("passes axe in light and in dark", async ({ page, app, database }) => {
    await open(page, app.link, database);
    const check = async (name: string) => {
      await settleForAxe(page);
      await page.addScriptTag({ content: axeSource });
      const found = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: {
              run: (
                c: Element,
                o: object,
              ) => Promise<{ violations: Array<{ id: string; impact: string | null }> }>;
            };
          }
        ).axe;
        const result = await axe.run(document.querySelector('[role="dialog"]') ?? document.body, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        });
        return result.violations.map((v) => `${v.id} (${v.impact})`);
      });
      expect.soft(found, `axe on the documentation export (${name})`).toEqual([]);
    };
    await expect(page.getByRole("dialog").getByLabel("What to describe")).toBeVisible();
    await check("light");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByRole("button", { name: "Export documentation" }).click();
    await expect(page.getByRole("dialog").getByLabel("What to describe")).toBeVisible();
    await check("dark");
  });
});
