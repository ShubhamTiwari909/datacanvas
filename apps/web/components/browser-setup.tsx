/** Runs the browser-only setup that has to happen before the first response is parsed (see `lib/zod-config.ts`). */
"use client";

import "@/lib/zod-config";

export function BrowserSetup(): null {
  return null;
}
