/**
 * Translate whatever the `pg` driver (or Node's networking layer) throws into
 * a `DatabaseError` with a stable code and a safe message.
 *
 * Why this file matters: raw driver messages can contain host names, user
 * names, database names and fragments of SQL. Nothing outside this package may
 * ever see them, so every adapter method funnels its failures through here.
 * The raw error is kept as `cause` for server-side debugging only.
 *
 * Errors reach us in three flavours, and they are checked in this order:
 *   1. PostgreSQL server errors carry a 5-character SQLSTATE in `error.code`
 *      (e.g. "28P01"). These are the most precise, so they win.
 *   2. Node.js errors carry a symbolic code (e.g. "ECONNREFUSED") or a TLS
 *      verification code (e.g. "SELF_SIGNED_CERT_IN_CHAIN").
 *   3. The driver sometimes throws a plain Error with only a message
 *      ("timeout exceeded when trying to connect"), so we fall back to
 *      pattern-matching the message. This is the least reliable, hence last.
 */
import { DatabaseError, isDatabaseError } from "@datacanvas/database-core";

/** Node.js socket errors that all mean "we could not talk to the server". */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ECONNABORTED",
  "EAI_AGAIN",
  "EPIPE",
]);

/** Certificate verification failures reported by Node's TLS layer. */
const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "HOSTNAME_MISMATCH",
]);

/** The server (not the driver) said "no" because of how we tried to connect. */
const PG_HBA_REJECTION = /pg_hba\.conf/i;

function readField(error: unknown, field: "code" | "message"): string {
  if (typeof error === "object" && error !== null && field in error) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Convert any thrown value into a `DatabaseError`. Never returns a raw driver error. */
export function mapPgError(error: unknown): DatabaseError {
  if (isDatabaseError(error)) return error;

  const code = readField(error, "code");
  const message = readField(error, "message");
  const wrap = (databaseCode: ConstructorParameters<typeof DatabaseError>[0]): DatabaseError =>
    new DatabaseError(databaseCode, { cause: error });

  // --- 1. PostgreSQL SQLSTATE codes -------------------------------------
  switch (code) {
    case "28P01": // invalid_password
      return wrap("authentication_failed");
    case "28000": // invalid_authorization_specification
      // Also used when pg_hba.conf has no matching rule. If the message says the
      // rule failed because of encryption, the real problem is TLS, not the password.
      if (PG_HBA_REJECTION.test(message) && /\b(SSL|encryption|TLS)\b/i.test(message)) {
        return wrap("ssl_error");
      }
      return wrap("authentication_failed");
    case "3D000": // invalid_catalog_name: the database does not exist
      return wrap("database_not_found");
    case "42501": // insufficient_privilege
      return wrap("permission_denied");
    case "57014": // query_canceled: our statement_timeout fired
      return wrap("timeout");
    case "57P01": // admin_shutdown
    case "57P02": // crash_shutdown
    case "57P03": // cannot_connect_now (server starting up)
    case "08000": // connection_exception
    case "08001": // sqlclient_unable_to_establish_sqlconnection
    case "08003": // connection_does_not_exist
    case "08006": // connection_failure
      return wrap("unreachable");
  }

  // --- 2. Node.js error codes -------------------------------------------
  if (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")) {
    return wrap("ssl_error");
  }
  if (code === "ETIMEDOUT") return wrap("timeout");
  if (NETWORK_ERROR_CODES.has(code)) return wrap("unreachable");

  // --- 3. Message patterns (the driver throws plain Errors for these) ----
  if (/\b(SSL|TLS)\b/i.test(message)) return wrap("ssl_error");
  if (/\bSASL\b|SCRAM|no password was provided|password must be a string/i.test(message)) {
    return wrap("authentication_failed");
  }
  if (/time(d)? ?out/i.test(message)) return wrap("timeout");
  if (/connection terminated|not queryable|connection error/i.test(message)) {
    return wrap("unreachable");
  }

  return wrap("unexpected");
}
