/**
 * Plain constants shared by every workspace. Kept free of runtime
 * dependencies so the CLI can import them without pulling in Zod.
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
