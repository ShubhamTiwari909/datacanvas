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
import { profileIdSchema } from "./ids.js";

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
  .superRefine((value, ctx) => {
    if (value.startsWith("/")) ctx.addIssue({ code: "custom", message: SOCKET_HOST_MESSAGE });
    else if (!/^[^\s/@?#]+$/.test(value)) {
      ctx.addIssue({ code: "custom", message: "Host must not contain spaces or any of / @ ? #" });
    }
  });
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

/**
 * Said when the host is a file path (a Unix socket such as /cloudsql/PROJECT:REGION:INSTANCE
 * or /var/run/postgresql). A socket exists only on the machine where the
 * database or a proxy for it runs, and DataCanvas connects over the network, so
 * the useful answer is where to point it instead. It never repeats the input.
 */
export const SOCKET_HOST_MESSAGE =
  "The host is a Unix socket path (such as /cloudsql/..., used inside Google Cloud), which only exists " +
  "on the machine where the database or its proxy runs. DataCanvas connects over the network: use the " +
  "database's host name or IP address, or, for Google Cloud SQL, run the Cloud SQL Auth Proxy and " +
  "connect to 127.0.0.1 and the port it listens on.";

const NO_HOST_MESSAGE =
  "The connection string has no host. Put it after the @ (postgresql://user:password@host:5432/database), " +
  "or add ?host=host.example.com.";

const failure = (message: string): { ok: false; message: string } => ({ ok: false, message });

/**
 * Stand-in for an empty host. A URL such as `postgresql://user:pw@/db?host=...`
 * (credentials but no host, the way libpq and Cloud SQL write it) is rejected by
 * the standard URL parser, so an empty host is replaced by this reserved
 * (`.invalid` never resolves) name before parsing and turned back into "no
 * host" afterwards.
 */
const EMPTY_HOST_STAND_IN = "datacanvas-empty-host.invalid";
const EMPTY_HOST_AFTER_CREDENTIALS = /^(postgres(?:ql)?:\/\/[^/?#]*@)(?=[/?#]|$)/i;

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
 * Understood query parameters: `sslmode`, and `host` / `port` (the libpq way
 * of writing them, used when the address has no host, as in
 * `postgresql://user:pw@/db?host=10.1.2.3`). Other parameters (for example
 * `options`, `application_name` or Prisma's `schema`) are intentionally
 * ignored so a pasted string can never change session behaviour behind the
 * user's back. A host that is a file path (Unix socket) is refused with an
 * explanation, because DataCanvas connects over the network only.
 *
 * Messages never include the input (it contains the password).
 */
export function parsePostgresConnectionString(raw: string): ParseResult<ParsedConnectionString> {
  let url: URL;
  try {
    // An empty host after the credentials is legal for libpq but not for URL: see EMPTY_HOST_STAND_IN.
    url = new URL(raw.trim().replace(EMPTY_HOST_AFTER_CREDENTIALS, `$1${EMPTY_HOST_STAND_IN}`));
  } catch {
    return failure(`This does not look like a valid connection string. ${FORMAT_HELP}`);
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return failure("The connection string must start with postgresql:// or postgres://.");
  }

  // IPv6 hosts come back in brackets ("[::1]"); the driver wants them without.
  let host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === EMPTY_HOST_STAND_IN) host = "";

  // libpq also allows the host (and port) as query parameters: ?host=db.example.com&port=5432.
  const queryHost = url.searchParams.get("host");
  const queryPort = url.searchParams.get("port");
  if (queryHost !== null && queryHost.includes(",")) {
    return failure("Several hosts in one connection string are not supported. Use one host.");
  }
  // A socket path in ?host= wins in libpq whatever the URL's own host says (Prisma writes
  // postgresql://user:pw@localhost/db?host=/cloudsql/...), so it is refused in either place.
  if (queryHost !== null && queryHost.startsWith("/")) return failure(SOCKET_HOST_MESSAGE);
  if (host.startsWith("/")) return failure(SOCKET_HOST_MESSAGE);

  if (host === "") {
    if (queryHost === null || queryHost.trim() === "") return failure(NO_HOST_MESSAGE);
    host = queryHost.trim();
  } else if (queryHost !== null && queryHost.trim() !== "" && queryHost.trim() !== host) {
    // Never pick one silently: connecting to the wrong server is worse than an error.
    return failure(
      "The connection string names two different hosts (in the address and in ?host=).",
    );
  }

  let port = url.port === "" ? DEFAULT_POSTGRES_PORT : Number(url.port);
  if (queryPort !== null && queryPort !== "") {
    const parsedPort = /^\d{1,5}$/.test(queryPort) ? Number(queryPort) : Number.NaN;
    if (url.port === "") port = parsedPort;
    else if (parsedPort !== port) {
      return failure(
        "The connection string names two different ports (in the address and in ?port=).",
      );
    }
  }

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

/**
 * Fields that say what to do with the connection AFTER it works. They are not
 * part of the connection itself and are never sent to the database.
 *   remember   save the connection's non-secret details as a profile
 *              (the password is never saved);
 *   profileId  this connection IS an existing saved profile being reconnected
 *              (so no second profile is created).
 */
const persistenceFields = {
  remember: z.boolean().optional(),
  profileId: profileIdSchema.optional(),
  /**
   * Allow viewing table data (rows) for this connection. Off unless asked for. When
   * a saved profile is reconnected and this is omitted, the profile's own setting
   * applies. It is a setting of DataCanvas, never sent to the database.
   */
  dataAccess: z.boolean().optional(),
};

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
  ...persistenceFields,
});

/** Mode "string": a pasted connection URL. The string is parsed during validation. */
export const postgresStringInputSchema = z
  .strictObject({
    mode: z.literal("string"),
    name: nameSchema,
    connectionString: z.string().trim().min(1, "Paste a connection string.").max(2048),
    ...persistenceFields,
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
    const {
      mode: _mode,
      sslMode,
      remember: _remember,
      profileId: _profileId,
      dataAccess: _dataAccess,
      ...rest
    } = input;
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
  /** Table data (rows) may be viewed on this connection. Off by default; remembered with a saved connection. */
  dataAccess: z.boolean(),
});

export type PostgresConnectionSummary = z.infer<typeof postgresConnectionSummarySchema>;

/** Drop the password, keeping only whether one was provided. */
export function summarizePostgresConnection(
  connection: ResolvedPostgresConnection,
  dataAccess = false,
): PostgresConnectionSummary {
  const { password, ...rest } = connection;
  return { ...rest, hasPassword: password !== "", dataAccess };
}
