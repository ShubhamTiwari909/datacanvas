/**
 * Zod, in the browser, without code generation.
 *
 * Zod 4 speeds up parsing by compiling a function with `new Function` when the page allows it, and finds out whether
 * it is allowed by trying. Under the Content-Security-Policy (`lib/security/csp.ts`: no `unsafe-eval`) that try is
 * itself a violation, even though zod catches it and falls back. So the browser is told not to try (`jitless`): the
 * parsing is the same and the policy sees nothing to report. The server keeps the fast path (it has no policy to meet).
 *
 * Imported for its effect, before anything parses: by `api-client.ts` and by `BrowserSetup` in the layout.
 */
import { z } from "zod";

z.config({ jitless: true });
