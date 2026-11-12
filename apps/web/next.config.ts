/**
 * Next.js configuration for the DataCanvas web app.
 *
 * Two settings here exist purely to keep installation simple for end users
 * (see docs/decisions.md):
 *  - `output: "standalone"` makes `next build` produce a self-contained server
 *    folder with only the files and node_modules it needs. The published npm
 *    package ships that folder, so users never run a build or install Next.js.
 *  - `images.unoptimized` turns off the built-in image optimizer, which would
 *    otherwise depend on the native `sharp` module.
 */
import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  // In a monorepo the workspace packages live outside apps/web. Next.js traces
  // which files the server needs starting from this folder; if it were left at
  // the default (apps/web), files from the repo root and sibling packages
  // would be missing from the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../.."),

  images: { unoptimized: true },

  // NOTE: even with `images.unoptimized`, the standalone tracer still copies
  // `sharp` (native image library) and a platform-specific binary. Next.js'
  // outputFileTracingExcludes cannot remove it (it only affects per-route
  // traces, and sharp comes from the shared server trace). So
  // scripts/build-package.mjs prunes sharp when assembling the npm package and
  // fails the build if any native (.node) file remains.

  // Never advertise the framework in a response header.
  poweredByHeader: false,
};

export default nextConfig;
