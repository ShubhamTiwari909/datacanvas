/**
 * Route-level loading UI. Next.js shows this automatically (via React
 * Suspense) while a page's server-side work is still in progress.
 */
import { LoadingState } from "@/components/states/loading-state";

export default function Loading() {
  return <LoadingState />;
}
