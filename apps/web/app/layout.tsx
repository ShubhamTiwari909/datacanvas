/**
 * Root layout: wraps every page. It is a Server Component (no "use client"),
 * so it renders on the server and ships no JavaScript of its own.
 */
import type { Metadata } from "next";
import { APP_NAME } from "@datacanvas/shared-types";
import { NO_FLASH_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "DataCanvas",
  description: "A local-first visual PostgreSQL explorer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the script below sets the theme class on <html> before
    // React loads, so the attributes differ from what the server rendered, on purpose.
    <html lang="en" data-app={APP_NAME} suppressHydrationWarning>
      <head>
        {/* Applies the saved theme before the first paint, so there is no white flash in dark mode. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
