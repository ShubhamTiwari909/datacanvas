/**
 * @datacanvas/shared-types
 *
 * Single source of truth for values and contracts that more than one workspace
 * needs. In Phase 0 it only holds two constants, which is enough to prove that
 * one workspace package can import another. Zod schemas and API types arrive
 * in Phase 3.
 *
 * This package must stay free of Node-only and browser-only APIs so that the
 * CLI, the Next.js server code and the Next.js client code can all import it.
 */

/** Public product name; also the planned npm package name. */
export const APP_NAME = "datacanvas";

/**
 * Port DataCanvas tries first.
 *
 * It is fixed (rather than random) so the browser origin stays stable between
 * runs. The CLI falls back to another free port only when this one is taken.
 */
export const DEFAULT_PORT = 4747;

/**
 * Body returned by `GET /api/health`.
 *
 * Plain TypeScript types are enough for now. In Phase 3 the API contracts become
 * Zod schemas (types are then inferred from them), because a TypeScript type
 * cannot check data that arrives over HTTP at runtime.
 */
export interface HealthResponse {
  status: "ok";
  application: typeof APP_NAME;
}

/**
 * The single error shape used by every API route, so the UI can handle
 * failures in one place. `code` is stable and machine-readable (for example
 * "not_found"); `message` is a safe, human-readable sentence. Never put
 * secrets, SQL or raw driver errors in it.
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
