/**
 * Contract and validation for PostgreSQL connection details.
 *
 * A user can describe a connection in two ways ("modes"):
 *   - "string": paste a URL such as postgresql://user:pass@host:5432/db
 *   - "fields": fill in host, port, database, username and password separately
 *
 * Both are validated here, then reduced to one normalised shape
 * (`ResolvedPostgresConnection`) that the rest of the system uses.
 *
 * SECURITY RULES for everything in this file:
 *   - passwords and connection strings must never appear in error messages,
 *     because those messages are returned to the browser and may be logged;
 *   - only `PostgresConnectionSummary` (no password) is safe to send back to a client.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Field rules (shared by both modes)
// ---------------------------------------------------------------------------

/**
 * How TLS (encryption) is used:
 *   "disable"     no encryption. Only for a database on your own machine.
 *   "require"     encrypted, but the server certificate is NOT verified, so it
 *                 protects against eavesdropping but not against impersonation.
 *   "verify-full" encrypted and the certificate and host name are verified.
 *                 Recommended, and therefore the default.
 */
export const sslModeSchema = z.enum(["disable", "require", "verify-full"]);
export type PostgresSslMode = z.infer<typeof sslModeSchema>;

export const DEFAULT_POSTGRES_PORT = 5432;

/** Host names that always mean "this very machine". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The SSL mode used when the user did not choose one.
 *
 *   - Connections to THIS machine ("localhost", 127.0.0.1, ::1) default to
 *     "disable": the traffic never leaves the computer, so encryption protects
 *     nothing, and a typical local development database has no TLS. Without
 *     this, pasting a local connection string would fail on the first try.
 *   - Every other host defaults to "verify-full": encrypted AND the server's
 *     identity is verified. We deliberately do not use libpq's "prefer", which
 *     silently falls back to an unencrypted connection.
 *
 * An explicit choice always wins over this default.
 */
export function defaultSslMode(host: string): PostgresSslMode {
  return LOOPBACK_HOSTS.has(host.toLowerCase()) ? "disable" : "verify-full";
}

const nameSchema = z.string().trim().min(1, "Give the connection a name.").max(100);
const hostSchema = z
  .string()
  .trim()
  .min(1, "Host is required.")
  .max(255)
  .regex(/^[^\s/@?#]+$/, "Host must not contain spaces or any of / @ ? #");
const portSchema = z.number().int().min(1).max(65535);
// PostgreSQL identifiers (database and role names) are at most 63 bytes long.
const databaseSchema = z.string().trim().min(1, "Database name is required.").max(63);
const usernameSchema = z.string().trim().min(1, "Username is required.").max(63);
// May be empty: some databases (local, or "trust" authentication) need no password.
const passwordSchema = z.string().max(1024);

// ---------------------------------------------------------------------------
// Connection-string parsing
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface ParsedConnectionString {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: PostgresSslMode;
}

const FORMAT_HELP =
  "Expected postgresql://user:password@host:5432/database. " +
  "Special characters in the user name or password (such as @ / # ? %) must be URL-encoded.";

const failure = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** `decodeURIComponent` throws on malformed input such as "%zz"; turn that into a null. */
function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Parse a PostgreSQL connection URL into its parts.
 *
 * Only the `sslmode` query parameter is understood. Other parameters (for
 * example `options` or `application_name`) are intentionally ignored so a
 * pasted string can never change session behaviour behind the user's back.
 *
 * Messages never include the input (it contains the password).
 */
export function parsePostgresConnectionString(raw: string): ParseResult<ParsedConnectionString> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return failure(`This does not look like a valid connection string. ${FORMAT_HELP}`);
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return failure("The connection string must start with postgresql:// or postgres://.");
  }

  // IPv6 hosts come back in brackets ("[::1]"); the driver wants them without.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") return failure("The connection string has no host.");

  const port = url.port === "" ? DEFAULT_POSTGRES_PORT : Number(url.port);

  // The path is "/databasename". Reject extra path segments instead of guessing.
  const database = decode(url.pathname.replace(/^\//, ""));
  if (database === null) return failure("The database name contains invalid URL encoding.");
  if (database === "") return failure("The connection string has no database name.");
  if (database.includes("/")) return failure("The database name must not contain a slash.");

  const username = decode(url.username);
  const password = decode(url.password);
  if (username === null || password === null) {
    return failure("The user name or password contains invalid URL encoding.");
  }
  if (username === "") return failure("The connection string has no user name.");

  // No sslmode given: use the host-aware default (see `defaultSslMode`).
  let sslMode: PostgresSslMode = defaultSslMode(host);
  const requested = url.searchParams.get("sslmode");
  if (requested !== null) {
    if (requested === "disable" || requested === "require") sslMode = requested;
    else if (requested === "verify-full" || requested === "verify-ca") sslMode = "verify-full";
    else {
      return failure("sslmode must be one of: disable, require, verify-ca, verify-full.");
    }
  }

  // Apply the same length/range rules the "fields" mode uses.
  const checked = z
    .object({
      host: hostSchema,
      port: portSchema,
      database: databaseSchema,
      username: usernameSchema,
      password: passwordSchema,
    })
    .safeParse({ host, port, database, username, password });
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const field = issue?.path[0] === undefined ? "value" : String(issue.path[0]);
    return failure(
      `The ${field} in the connection string is not valid: ${issue?.message ?? ""}`.trim(),
    );
  }

  return { ok: true, value: { ...checked.data, sslMode } };
}

// ---------------------------------------------------------------------------
// Request schemas (what the browser sends)
// ---------------------------------------------------------------------------

/** Mode "fields": every part supplied separately. Unknown keys are rejected (strictObject). */
export const postgresFieldsInputSchema = z.strictObject({
  mode: z.literal("fields"),
  name: nameSchema,
  host: hostSchema,
  port: portSchema.default(DEFAULT_POSTGRES_PORT),
  database: databaseSchema,
  username: usernameSchema,
  password: passwordSchema.default(""),
  // Optional: when omitted the host decides (see `defaultSslMode`).
  sslMode: sslModeSchema.optional(),
});

/** Mode "string": a pasted connection URL. The string is parsed during validation. */
export const postgresStringInputSchema = z
  .strictObject({
    mode: z.literal("string"),
    name: nameSchema,
    connectionString: z.string().trim().min(1, "Paste a connection string.").max(2048),
  })
  .superRefine((value, ctx) => {
    const parsed = parsePostgresConnectionString(value.connectionString);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", path: ["connectionString"], message: parsed.message });
    }
  });

/** Either mode; the `mode` field decides which schema applies. */
export const postgresConnectionInputSchema = z.discriminatedUnion("mode", [
  postgresFieldsInputSchema,
  postgresStringInputSchema,
]);

/** Validated input, with defaults applied (port, password). `sslMode` is resolved later. */
export type PostgresConnectionInput = z.infer<typeof postgresConnectionInputSchema>;

// ---------------------------------------------------------------------------
// Normalised shapes (what the server works with, and what it may reveal)
// ---------------------------------------------------------------------------

/** One normalised connection, regardless of how it was entered. CONTAINS THE PASSWORD: server-side only. */
export interface ResolvedPostgresConnection {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: PostgresSslMode;
}

/**
 * Turn validated input into the single normalised shape.
 *
 * Call this only with data that passed `postgresConnectionInputSchema`.
 */
export function resolvePostgresConnection(
  input: PostgresConnectionInput,
): ResolvedPostgresConnection {
  if (input.mode === "fields") {
    const { mode: _mode, sslMode, ...rest } = input;
    return { ...rest, sslMode: sslMode ?? defaultSslMode(input.host) };
  }
  const parsed = parsePostgresConnectionString(input.connectionString);
  if (!parsed.ok) {
    // Unreachable for validated input. The message is safe (it never echoes the string).
    throw new Error(`Cannot resolve an unvalidated connection: ${parsed.message}`);
  }
  return { name: input.name, ...parsed.value };
}

/** The part of a connection that is safe to send to the browser: everything except the password. */
export const postgresConnectionSummarySchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number(),
  database: z.string(),
  username: z.string(),
  sslMode: sslModeSchema,
  hasPassword: z.boolean(),
});

export type PostgresConnectionSummary = z.infer<typeof postgresConnectionSummarySchema>;

/** Drop the password, keeping only whether one was provided. */
export function summarizePostgresConnection(
  connection: ResolvedPostgresConnection,
): PostgresConnectionSummary {
  const { password, ...rest } = connection;
  return { ...rest, hasPassword: password !== "" };
}
