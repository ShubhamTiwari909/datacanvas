/**
 * Placeholder CLI entry point (Phase 0).
 *
 * Its only job right now is to prove the monorepo wiring: this file imports a
 * value from another workspace package (`@datacanvas/shared-types`), which npm
 * workspaces resolves through a symlink in the root `node_modules`.
 *
 * The real launcher (port selection, starting the bundled Next.js server,
 * opening the browser, graceful shutdown) is built in Phases 2 and 11.
 */
import { APP_NAME, DEFAULT_PORT } from "@datacanvas/shared-types";

console.log(`${APP_NAME} placeholder CLI: will listen on 127.0.0.1:${DEFAULT_PORT}`);
