/**
 * Root layout: wraps every page. It is a Server Component (no "use client"),
 * so it renders on the server and ships no JavaScript of its own.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { APP_NAME } from "@datacanvas/shared-types";
import { NO_FLASH_SCRIPT } from "@/lib/theme";
import { BrowserSetup } from "@/components/browser-setup";
import "./globals.css";

export const metadata: Metadata = {
  title: "DataCanvas",
  description: "A local-first visual PostgreSQL explorer.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The nonce `proxy.ts` made for this request (the page is rendered per request, which is what lets the framework put
  // the same nonce on its own scripts). Without one (a test that renders the layout) the script gets none.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // suppressHydrationWarning: the script below sets the theme class on <html> before
    // React loads, so the attributes differ from what the server rendered, on purpose.
    <html lang="en" data-app={APP_NAME} suppressHydrationWarning>
      <head>
        {/* Applies the saved theme before the first paint, so there is no white flash in dark mode. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <BrowserSetup />
        {children}
      </body>
    </html>
  );
}
