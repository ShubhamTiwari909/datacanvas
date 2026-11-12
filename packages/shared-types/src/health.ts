/**
 * Contract for `GET /api/health`.
 */
import { z } from "zod";
import { APP_NAME } from "./constants.js";

/**
 * A Zod schema is both a runtime validator and the source of the TypeScript
 * type (see `HealthResponse` below), so the two can never drift apart.
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  application: z.literal(APP_NAME),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
