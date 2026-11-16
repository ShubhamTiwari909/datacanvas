/**
 * The single error shape used by every API route, so the UI can handle
 * failures in one place:
 *
 *   { "error": { "code": "validation_error", "message": "...", "issues": [...] } }
 *
 * `code` is stable and machine-readable; `message` is a safe, human-readable
 * sentence. SECURITY: neither may ever contain secrets, SQL, connection
 * strings or raw driver errors; the browser (and logs) will see them.
 */
import { z } from "zod";

/** Codes the server currently produces. Add new ones here so clients can switch on them. */
export const API_ERROR_CODES = [
  "not_found",
  "invalid_json",
  "validation_error",
  "unsupported_media_type",
  "payload_too_large",
  // Local-server protection: wrong Host/Origin, or no valid session.
  "unauthorized",
  "forbidden",
  // Database problems (mirror DatabaseErrorCode in @datacanvas/database-core;
  // a type test keeps the two lists in sync). "not_found" above also covers a
  // missing schema or table.
  "authentication_failed",
  "unreachable",
  "ssl_error",
  "timeout",
  "permission_denied",
  "database_not_found",
  "not_connected",
  "invalid_request",
  "not_supported",
  "unexpected",
  // Connection registry problems.
  "connection_not_found",
  "connection_limit_reached",
  // Saved connections and workspaces.
  "profile_not_found",
  "workspace_not_found",
  "workspace_limit_reached",
  "invalid_workspace_file",
  // Viewing table data (rows).
  "data_access_disabled",
  "rows_busy",
  // Structure snapshots.
  "snapshot_not_found",
  "snapshot_limit_reached",
  "snapshot_too_large",
  "invalid_snapshot_file",
  "storage_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** One problem found while validating a request, pointing at the field that caused it. */
export const validationIssueSchema = z.object({
  /** Dotted path to the offending field, e.g. "connectionString". Empty for the whole body. */
  path: z.string(),
  message: z.string(),
});

export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    // Deliberately `string`, not the enum: an older UI must still be able to
    // read an error code that a newer server invents.
    code: z.string(),
    message: z.string(),
    /** Present for `validation_error`: one entry per invalid field. */
    issues: z.array(validationIssueSchema).optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
