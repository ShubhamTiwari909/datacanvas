/**
 * Typed database errors.
 *
 * Database drivers throw all kinds of low-level errors with detailed messages
 * that can contain host names, user names, SQL fragments or even parts of a
 * connection string. Adapters catch those and rethrow a `DatabaseError` with:
 *   - a stable `code` the UI and API can switch on, and
 *   - a SAFE `message` (a fixed sentence per code) that may be shown to the user.
 *
 * SECURITY: the original error is kept only in `cause`, for server-side
 * debugging. `cause` is never serialised (see `toJSON`) and must never be
 * copied into an API response or a log line without scrubbing.
 */

export const DATABASE_ERROR_CODES = [
  "authentication_failed",
  "unreachable",
  "ssl_error",
  "timeout",
  "permission_denied",
  "database_not_found",
  /** A schema or table that was asked for does not exist. */
  "not_found",
  /** A method was called before `connect()` or after `disconnect()`. */
  "not_connected",
  /** A request the adapter cannot act on: a page size out of range, or a paging position that does not belong to this table. */
  "invalid_request",
  /** The kind of table is not supported for this operation (for example reading rows of a foreign table). */
  "not_supported",
  /** A read with a sort or a filter ran longer than its short time limit and was stopped. */
  "too_slow",
  /** Anything we did not anticipate. */
  "unexpected",
  // ---- Writes (1.4.0). Messages are fixed or name structure only, never a value (decision 129).
  /** An update or delete found no row with the key and the values the person saw: nothing was written. */
  "row_changed",
  /** The table's rows cannot be edited (no key, a view, a foreign table). */
  "not_editable",
  /** A change that cannot be made as asked (a name, a type, a column that does not fit). */
  "invalid_change",
  /** SQLSTATE 23505. */
  "unique_violation",
  /** SQLSTATE 23503. */
  "foreign_key_violation",
  /** SQLSTATE 23502. */
  "not_null_violation",
  /** SQLSTATE 23514 and 23P01. */
  "check_violation",
  /** SQLSTATE class 22: a value that the column's type does not accept. */
  "invalid_value",
  /** SQLSTATE 55P03: the lock was not granted within the lock timeout. */
  "locked",
  /** SQLSTATE 40001 and 40P01. */
  "retry",
  /** SQLSTATE 42501 on a write. */
  "write_denied",
  /** Other objects depend on what was to be dropped or changed (no CASCADE, decision 130). */
  "has_dependents",
  /** A table, column, constraint or index with that name already exists. */
  "already_exists",
] as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[number];

/** The safe, user-facing sentence for each code. */
export const DEFAULT_ERROR_MESSAGES: Record<DatabaseErrorCode, string> = {
  authentication_failed: "Authentication failed. Check the user name and password.",
  unreachable:
    "Could not reach the database server. Check the host, port and that the server accepts connections from this machine.",
  ssl_error:
    'A secure (TLS) connection could not be established, or the server does not accept this SSL setting. Use SSL mode "disable" for a local database without TLS, or "verify-full" (with a certificate the server can prove) for a remote one.',
  timeout: "The database did not respond in time.",
  permission_denied: "The database user does not have permission to read this information.",
  database_not_found: "The database does not exist, or this user is not allowed to access it.",
  not_found: "The requested schema or table does not exist.",
  not_connected: "The database connection is not open.",
  invalid_request:
    "The request could not be used. The page size or the paging position is not valid for this table.",
  not_supported: "This kind of table cannot be read here (for example a foreign table).",
  too_slow:
    "This took longer than 5 seconds, so it was stopped. On a large table, sort or filter by a column that has an index, or narrow the filter.",
  unexpected: "An unexpected database error occurred.",
  row_changed:
    "This row was changed or deleted since you loaded it, so nothing was written. Reload the page and try again.",
  not_editable: "The rows of this table cannot be edited here.",
  invalid_change: "This change cannot be made.",
  unique_violation: "A row with the same value already exists.",
  foreign_key_violation: "This breaks a foreign key.",
  not_null_violation: "A column that cannot be empty was left empty.",
  check_violation: "A rule of the table refused this change.",
  invalid_value: "A value is not valid for its column's type.",
  locked: "The table is locked by another session. Nothing was changed. Try again.",
  retry: "The database asked for the change to be retried. Nothing was changed. Try again.",
  write_denied: "The database role cannot change this table.",
  has_dependents: "Other objects depend on this, so nothing was changed.",
  already_exists: "Something with this name already exists.",
};

export interface DatabaseErrorOptions {
  /**
   * Override the default message. It MUST be safe to show to the user: never
   * include credentials, connection strings, SQL or the driver's own message.
   */
  message?: string;
  /** The underlying error, kept for server-side debugging only. */
  cause?: unknown;
}

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, options: DatabaseErrorOptions = {}) {
    // `cause` is stored by the Error base class as a non-enumerable property,
    // so it does not show up when the error is spread or printed as JSON.
    super(options.message ?? DEFAULT_ERROR_MESSAGES[code], { cause: options.cause });
    this.name = "DatabaseError";
    this.code = code;
  }

  /** Only the safe parts. `JSON.stringify(error)` therefore can never leak `cause`. */
  toJSON(): { code: DatabaseErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isDatabaseError(value: unknown): value is DatabaseError {
  return value instanceof DatabaseError;
}
