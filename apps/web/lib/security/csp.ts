/**
 * The Content-Security-Policy of a page (`docs/insight-release-plan.md`, section 4; decision 163).
 *
 * `proxy.ts` makes a nonce for each request and sends this policy with it: a script runs only when it carries the
 * nonce (the framework puts it on its own scripts when the request holds the policy, and the layout puts it on the one
 * script of ours), and a script that such a script loads is allowed by `'strict-dynamic'`. So text that ends up in a
 * page (a table name, a value) can never run as a script even if some component forgot to escape it.
 *
 * Pure functions, no framework: the rules are unit tested and a Playwright fixture fails any test that causes a
 * `securitypolicyviolation`.
 */

/** A fresh nonce: 128 random bits, base64. Never reused, never derived from anything. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface CspOptions {
  /** The development server needs `eval` for its refresh; the packaged app never gets it. */
  dev?: boolean;
}

/**
 * The policy for one response.
 *
 *  - Scripts: the nonce and what a nonced script loads. No `'unsafe-inline'`, no `'unsafe-eval'` outside development.
 *  - Styles keep `'unsafe-inline'`: React Flow and the menus set `style` attributes, which a nonce cannot cover. No code
 *    runs from a style, so this is a smaller hole than scripts (said in SECURITY.md).
 *  - Workers: Monaco's editor worker is part of the package (`'self'`); the spike found nothing that needs `blob:`.
 *  - Images: `'self'` and `data:`; the image export is a download, which no policy governs. Fonts: `'self'` only.
 *  - Connections: the API of the same origin only. Nothing is ever sent to another site.
 */
export function buildCsp(nonce: string, options: CspOptions = {}): string {
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'none'"]],
    [
      "script-src",
      ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(options.dev ? ["'unsafe-eval'"] : [])],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'"]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
