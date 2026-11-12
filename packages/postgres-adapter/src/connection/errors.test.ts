import { DatabaseError } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { mapPgError } from "./errors.js";

/** Build an error shaped like the ones `pg` and Node throw. */
function fake(code: string | undefined, message: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("mapPgError", () => {
  it.each([
    // PostgreSQL SQLSTATE codes
    ["28P01", 'password authentication failed for user "alice"', "authentication_failed"],
    ["28000", 'role "alice" does not exist', "authentication_failed"],
    ["3D000", 'database "shop" does not exist', "database_not_found"],
    ["42501", "permission denied for database shop", "permission_denied"],
    ["57014", "canceling statement due to statement timeout", "timeout"],
    ["57P03", "the database system is starting up", "unreachable"],
    ["08006", "connection failure", "unreachable"],
    // pg_hba.conf rejections that are really about encryption
    [
      "28000",
      'no pg_hba.conf entry for host "10.0.0.5", user "alice", database "shop", no encryption',
      "ssl_error",
    ],
    [
      "28000",
      'no pg_hba.conf entry for host "10.0.0.5", user "alice", database "shop", SSL off',
      "ssl_error",
    ],
    // Node networking
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432", "unreachable"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND db.internal", "unreachable"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.5:5432", "unreachable"],
    ["ECONNRESET", "read ECONNRESET", "unreachable"],
    ["ETIMEDOUT", "connect ETIMEDOUT 10.0.0.5:5432", "timeout"],
    // TLS certificate problems
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain", "ssl_error"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate", "ssl_error"],
    [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "Hostname/IP does not match certificate's altnames",
      "ssl_error",
    ],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate", "ssl_error"],
    // Plain driver errors identified by message only
    [undefined, "The server does not support SSL connections", "ssl_error"],
    [undefined, "timeout exceeded when trying to connect", "timeout"],
    [undefined, "Connection terminated due to connection timeout", "timeout"],
    [undefined, "Query read timeout", "timeout"],
    [undefined, "Connection terminated unexpectedly", "unreachable"],
    [
      undefined,
      "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string",
      "authentication_failed",
    ],
    // Anything else
    [undefined, "something nobody anticipated", "unexpected"],
    ["XX000", "internal_error", "unexpected"],
  ] as const)("maps %s / %s to %s", (code, message, expected) => {
    expect(mapPgError(fake(code, message)).code).toBe(expected);
  });

  it("returns an existing DatabaseError unchanged", () => {
    const original = new DatabaseError("not_found");
    expect(mapPgError(original)).toBe(original);
  });

  it("copes with values that are not Errors", () => {
    expect(mapPgError("boom").code).toBe("unexpected");
    expect(mapPgError(null).code).toBe("unexpected");
    expect(mapPgError(undefined).code).toBe("unexpected");
    expect(mapPgError({ code: 42, message: ["not", "a", "string"] }).code).toBe("unexpected");
  });

  it("never leaks the driver's message, but keeps it as the cause", () => {
    const raw = fake(
      "28P01",
      'password authentication failed for user "alice" (host db.internal, db shop)',
    );
    const mapped = mapPgError(raw);
    const serialised = JSON.stringify(mapped) + mapped.message;

    expect(mapped.cause).toBe(raw);
    for (const secret of ["alice", "db.internal", "shop"]) {
      expect(serialised).not.toContain(secret);
    }
  });
});
