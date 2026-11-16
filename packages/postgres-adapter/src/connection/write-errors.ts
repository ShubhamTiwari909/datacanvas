/**
 * Translate a failed WRITE into a `DatabaseError` with a fixed message
 * (decision 129).
 *
 * PostgreSQL puts row values into its messages ("Key (email)=(a@x.test)
 * already exists", "invalid input syntax for type integer: \"abc\""), so its
 * message is never used. The SQLSTATE picks a fixed sentence, which may name a
 * constraint, a column or a table (structure, taken from the error's own
 * fields), never a value. The raw error stays in `cause`, for the server only.
 */
import { DatabaseError, isDatabaseError, type DatabaseErrorCode } from "@datacanvas/database-core";
import { mapPgError } from "./errors.js";

function field(error: unknown, name: "code" | "constraint" | "column" | "table"): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** ` (name)` when there is a name, else nothing. Names are quoted the way people read them. */
const named = (name: string | null): string => (name ? ` (${name})` : "");

export function mapWriteError(error: unknown): DatabaseError {
  if (isDatabaseError(error)) return error;
  const code = field(error, "code") ?? "";
  const constraint = field(error, "constraint");
  const column = field(error, "column");
  const fail = (databaseCode: DatabaseErrorCode, message?: string): DatabaseError =>
    new DatabaseError(databaseCode, { cause: error, message });

  switch (code) {
    case "23505":
      return fail(
        "unique_violation",
        `A row with the same value already exists${named(constraint)}. Nothing was changed.`,
      );
    case "23503":
      return fail(
        "foreign_key_violation",
        `This breaks a foreign key${named(constraint)}: a referenced row is missing, or other rows still point at this one. Nothing was changed.`,
      );
    case "23502":
      return fail(
        "not_null_violation",
        column
          ? `${column} cannot be empty. Nothing was changed.`
          : "A column that cannot be empty was left empty. Nothing was changed.",
      );
    case "23514":
      return fail(
        "check_violation",
        `A check rule failed${named(constraint)}. Nothing was changed.`,
      );
    case "23P01":
      return fail(
        "check_violation",
        `This conflicts with an exclusion rule${named(constraint)}. Nothing was changed.`,
      );
    case "55P03":
      return fail("locked");
    case "40001":
    case "40P01":
      return fail("retry");
    case "42501":
      return fail("write_denied");
    case "25006":
      return fail(
        "write_denied",
        "This database is set to read-only, so nothing can be changed in it.",
      );
    case "2BP01":
      return fail("has_dependents");
    case "42P07":
      return fail(
        "already_exists",
        "A table, index or other object with this name already exists.",
      );
    case "42701":
      return fail("already_exists", "A column with this name already exists.");
    case "42710":
      return fail("already_exists", "An object with this name already exists.");
    case "42P16":
      return fail("invalid_change", "This change does not fit the table's definition.");
    case "42P01":
      return fail("not_found", "The table does not exist (any more).");
    case "42703":
      return fail("not_found", "A column does not exist (any more).");
    case "42830":
      return fail(
        "invalid_change",
        "The columns a foreign key points at must be the primary key or a unique key of their table.",
      );
    case "42804":
    case "42846":
      return fail(
        "invalid_change",
        "The types do not fit: PostgreSQL cannot convert between them on its own.",
      );
    case "0A000":
      return fail("invalid_change", "PostgreSQL does not support this change on this table.");
    case "57014":
      return fail("timeout", "The change took too long and was stopped. Nothing was changed.");
  }
  // Class 22 is "data exception": a value the column's type does not accept. The
  // message would contain the value, so only the fixed sentence is used.
  if (code.startsWith("22")) {
    return fail(
      "invalid_value",
      column
        ? `A value is not valid for ${column}. Nothing was changed.`
        : "A value is not valid for its column's type. Nothing was changed.",
    );
  }
  return mapPgError(error);
}
