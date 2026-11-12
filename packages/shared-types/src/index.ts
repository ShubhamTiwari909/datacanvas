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
