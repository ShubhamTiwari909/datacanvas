/**
 * Root layout: wraps every page. It is a Server Component (no "use client"),
 * so it renders on the server and ships no JavaScript of its own.
 */
import type { Metadata } from "next";
import { APP_NAME } from "@datacanvas/shared-types";
import "./globals.css";

export const metadata: Metadata = {
  title: "DataCanvas",
  description: "A local-first visual PostgreSQL explorer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-app={APP_NAME}>
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
