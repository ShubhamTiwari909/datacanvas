/**
 * The Content-Security-Policy of every page (`docs/insight-release-plan.md`, section 4; decision 163): a nonce made for
 * each request, on every script of the page, and nothing that runs without it. (Every other test of the suite also
 * fails when the page breaks the policy: see the `page` fixture.)
 */
import { expect, test } from "./fixtures";

test.use({ allowCspViolations: true });

const nonceOf = (policy: string): string | null =>
  /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1] ?? null;

test.describe("Content-Security-Policy", () => {
  test("a page comes with a policy that has a fresh nonce, and no eval, no inline script, no other site", async ({
    page,
    app,
  }) => {
    await page.goto(app.link);
    const first = await page.request.get(`${app.origin}/`);
    const second = await page.request.get(`${app.origin}/`);
    const policy1 = first.headers()["content-security-policy"] ?? "";
    const policy2 = second.headers()["content-security-policy"] ?? "";
    expect(policy1).toContain("default-src 'none'");
    expect(policy1).toContain("frame-ancestors 'none'");
    expect(policy1).toContain("object-src 'none'");
    expect(policy1).not.toContain("unsafe-eval");
    expect(policy1).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy1).not.toMatch(/https?:|\*/);
    const n1 = nonceOf(policy1);
    const n2 = nonceOf(policy2);
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
    expect(n1).not.toBe(n2);
  });

  test("every script of the page carries the nonce of its response", async ({ page, app }) => {
    await page.goto(app.link);
    const response = await page.request.get(`${app.origin}/`);
    const nonce = nonceOf(response.headers()["content-security-policy"] ?? "");
    expect(nonce).not.toBeNull();
    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag, "a script without the nonce of the response").toContain(`nonce="${nonce}"`);
    }
  });

  test("an inline handler that text in the page would add does not run, and is reported", async ({
    page,
    app,
  }) => {
    await page.goto(app.link);
    await expect(page.getByRole("button", { name: "Connect PostgreSQL" })).toBeVisible();
    const result = await page.evaluate(
      () =>
        new Promise<{ ran: string | undefined; reported: string[] }>((resolve) => {
          const reported: string[] = [];
          document.addEventListener("securitypolicyviolation", (e) =>
            reported.push(e.violatedDirective),
          );
          document.body.insertAdjacentHTML(
            "beforeend",
            `<img src="x" alt="" onerror="window.__injected = 'handler'">`,
          );
          setTimeout(
            () =>
              resolve({
                ran: (window as unknown as { __injected?: string }).__injected,
                reported,
              }),
            300,
          );
        }),
    );
    expect(result.ran).toBeUndefined();
    expect(result.reported.length).toBeGreaterThan(0);
  });

  test("a script that the parser meets without the nonce does not run", async ({ page, app }) => {
    await page.goto(app.link);
    await expect(page.getByRole("button", { name: "Connect PostgreSQL" })).toBeVisible();
    // (A script element made by script that already runs is allowed by 'strict-dynamic', on purpose: that script is
    // already trusted. What a missing escape would give an attacker is markup that the parser reads: it needs the nonce.)
    await page.evaluate(() => {
      document.write("<script>window.__injected = 'parsed script'</script>");
    });
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => (window as unknown as { __injected?: string }).__injected),
    ).toBeUndefined();
  });

  test("an answer of the API is JSON with no page policy to meet", async ({ page, app }) => {
    await page.goto(app.link);
    const response = await page.request.get(`${app.origin}/api/health`);
    expect(response.headers()["content-type"]).toContain("application/json");
  });
});
