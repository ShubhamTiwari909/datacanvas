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

  // Next.js buffers a request body for the proxy (`proxy.ts`) and keeps only the first 10 MB of it by default, so a
  // larger body reached a route cut short. An import is sent as JSON (up to IMPORT_MAX_BODY_BYTES, 32 MB), so the
  // buffer is a little larger. The route still refuses a body over its own limit; a rule test pins that this value is
  // at least the largest limit.
  experimental: { proxyClientMaxBodySize: "36mb" },

  // NOTE: even with `images.unoptimized`, the standalone tracer still copies
  // `sharp` (native image library) and a platform-specific binary. Next.js'
  // outputFileTracingExcludes cannot remove it (it only affects per-route
  // traces, and sharp comes from the shared server trace). So
  // scripts/build-package.mjs prunes sharp when assembling the npm package and
  // fails the build if any native (.node) file remains.

  // Never advertise the framework in a response header.
  poweredByHeader: false,

  // Browser-side hardening for every response.
  //  - frame-ancestors / X-Frame-Options: no other page may embed DataCanvas
  //    in a frame (clickjacking).
  //  - nosniff: the browser must trust our Content-Type, never guess.
  //  - Referrer-Policy: no Referer header is ever sent from DataCanvas pages.
  //  - Cross-Origin-Resource-Policy / Opener-Policy: other sites cannot load
  //    our responses as sub-resources or keep a handle on our window.
  // The Content-Security-Policy of a page (with a nonce made for each request) is set by `proxy.ts`
  // (`lib/security/csp.ts`, decision 163); the `frame-ancestors` here is for what the proxy does not touch.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
