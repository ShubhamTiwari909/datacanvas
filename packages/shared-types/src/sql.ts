/**
 * Contracts for the SQL view (1.6.0, decision 141): `POST /api/connections/:id/run`.
 *
 * Execution takes one statement and the body is
 * strict (no other key exists), and the answer is either a result or the database's
 * refusal of the statement (which is an answer, not a server error).
 */
import { z } from "zod";

// Limits, mirrored from @datacanvas/database-core (`SQL_LIMITS`; a test keeps them equal).
export const SQL_MAX_TEXT_CHARS = 200_000;
export const SQL_DEFAULT_MAX_ROWS = 1000;
export const SQL_MAX_MAX_ROWS = 10_000;
export const SQL_DEFAULT_TIMEOUT_MS = 30_000;
export const SQL_MIN_TIMEOUT_MS = 1000;
export const SQL_MAX_TIMEOUT_MS = 300_000;

export const sqlRunRequestSchema = z.strictObject({
  text: z.string().min(1).max(SQL_MAX_TEXT_CHARS),
  maxRows: z.number().int().min(1).max(SQL_MAX_MAX_ROWS).default(SQL_DEFAULT_MAX_ROWS),
  timeoutMs: z
    .number()
    .int()
    .min(SQL_MIN_TIMEOUT_MS)
    .max(SQL_MAX_TIMEOUT_MS)
    .default(SQL_DEFAULT_TIMEOUT_MS),
});
export type SqlRunRequestInput = z.input<typeof sqlRunRequestSchema>;
export type SqlRunRequest = z.output<typeof sqlRunRequestSchema>;

export const sqlResultSchema = z.object({
  columns: z.array(z.object({ name: z.string(), dataType: z.string() })),
  rows: z.array(z.array(z.string().nullable())),
  truncated: z.boolean(),
  command: z.string(),
  cutCells: z.number(),
  elapsedMs: z.number(),
});
export type SqlResult = z.infer<typeof sqlResultSchema>;

/** The database refused or stopped the statement (or it was cancelled or not allowed). */
export const sqlFailureSchema = z.object({
  /** A SQLSTATE, or `cancelled`, or `not_allowed`. */
  code: z.string(),
  message: z.string(),
  /** 1-based character position in the text, when the database gave one. */
  position: z.number().nullable(),
});
export type SqlFailure = z.infer<typeof sqlFailureSchema>;

export const sqlRunResponseSchema = z.union([
  z.object({ result: sqlResultSchema }),
  z.object({ failure: sqlFailureSchema }),
]);
export type SqlRunResponse = z.infer<typeof sqlRunResponseSchema>;

/** Only queries explicitly saved to the library use these contracts. */
export const MAX_SAVED_QUERIES = 100;
export const MAX_SAVED_QUERY_NAME_CHARS = 60;
export const MAX_SAVED_LIBRARY_CHARS = 2_000_000;
export const MAX_SAVED_QUERY_BODY_BYTES = SQL_MAX_TEXT_CHARS * 6 + 1024;

const savedQueryName = z.string().trim().min(1).max(MAX_SAVED_QUERY_NAME_CHARS);
const savedQueryText = z
  .string()
  .min(1)
  .max(SQL_MAX_TEXT_CHARS)
  .refine((text) => text.trim().length > 0);
const savedQueryIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
export const saveQueryRequestSchema = z.strictObject({
  name: savedQueryName,
  text: savedQueryText,
});
export const editSavedQueryRequestSchema = z.union([
  z.strictObject({ name: savedQueryName }),
  z.strictObject({ text: savedQueryText }),
]);
const savedQuerySummarySchema = z.strictObject({
  id: savedQueryIdSchema,
  name: savedQueryName,
});
export const savedQuerySchema = savedQuerySummarySchema.extend({ text: savedQueryText });
export const savedQueryFileSchema = z.strictObject({
  version: z.literal(1),
  queries: z.array(savedQuerySchema).max(MAX_SAVED_QUERIES),
});
export const savedQueryListSchema = z.strictObject({
  queries: z.array(savedQuerySummarySchema).max(MAX_SAVED_QUERIES),
});

export type SavedQuery = z.infer<typeof savedQuerySchema>;
export type SavedQuerySummary = z.infer<typeof savedQuerySummarySchema>;
export type SaveQueryRequest = z.infer<typeof saveQueryRequestSchema>;
export type EditSavedQueryRequest = z.infer<typeof editSavedQueryRequestSchema>;
