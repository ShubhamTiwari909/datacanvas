/**
 * Dark mode, end to end: choosing a theme, remembering it across a reload,
 * following the operating system only when set to System, and the canvas
 * library switching with it.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const html = (page: Page) => page.locator("html");

async function chooseTheme(page: Page, name: "Light" | "Dark" | "System") {
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

test("the theme can be chosen, is remembered, and follows the system only on System", async ({
  page,
  app,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(app.link);
  await expect(page.getByText("Backend status: Connected")).toBeVisible();

  // Starts as System: light here.
  await expect(html(page)).not.toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Theme: system. Change the theme" })).toBeVisible();

  // Choosing Dark applies at once and updates the label.
  await chooseTheme(page, "Dark");
  await expect(html(page)).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Theme: dark. Change the theme" })).toBeVisible();
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkBackground).not.toBe("rgb(255, 255, 255)");

  // Remembered across a reload, with the class already there when the page is first shown.
  await page.reload();
  await expect(html(page)).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Theme: dark. Change the theme" })).toBeVisible();

  // An explicit choice ignores the operating system.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).toHaveClass(/dark/);

  // System follows it, live.
  await chooseTheme(page, "System");
  await expect(html(page)).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html(page)).not.toHaveClass(/dark/);

  // Light stays light even when the system is dark.
  await chooseTheme(page, "Light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(html(page)).not.toHaveClass(/dark/);
});

test("a dark system with no saved choice starts dark before any app code runs", async ({
  page,
  app,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  // Block every script of the app itself: only the tiny inline script in <head> can set the class,
  // which is exactly what prevents a white flash while React loads.
  await page.route("**/_next/static/**/*.js", (route) => route.abort());
  await page.goto(app.link);
  await expect(html(page)).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
});

test("the canvas follows the theme", async ({ page, app, database }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(app.link);
  await page.getByRole("button", { name: "Connect PostgreSQL" }).click();
  await page.getByLabel("Connection name").fill("Theme shop");
  await page.getByRole("tab", { name: /connection string/i }).click();
  await page.getByRole("textbox", { name: "Connection string" }).fill(database.url);
  await page.getByRole("button", { name: /^Connect$/ }).click();
  await expect(page.getByRole("button", { name: "Disconnect Theme shop" })).toBeVisible();
  await page.getByRole("button", { name: "Add all tables of public to the canvas" }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();

  await expect(page.locator(".react-flow.light")).toBeVisible();
  await chooseTheme(page, "Dark");
  await expect(page.locator(".react-flow.dark")).toBeVisible();
  await chooseTheme(page, "Light");
  await expect(page.locator(".react-flow.light")).toBeVisible();
});
