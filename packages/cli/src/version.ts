/**
 * The CLI version, injected at bundle time.
 *
 * scripts/build-package.mjs runs esbuild with `define` that replaces
 * `__DATACANVAS_VERSION__` with the version string from package.json. When the
 * CLI runs un-bundled (plain `tsc` output during development) the identifier
 * does not exist, so we fall back to a dev marker. The `typeof` check is what
 * keeps that fallback from throwing a ReferenceError.
 */
declare const __DATACANVAS_VERSION__: string | undefined;

export const VERSION: string =
  typeof __DATACANVAS_VERSION__ === "string" ? __DATACANVAS_VERSION__ : "0.0.0-dev";
