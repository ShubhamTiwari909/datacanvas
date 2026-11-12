import { describe, expect, it } from "vitest";
import {
  DATABASE_ERROR_CODES,
  DEFAULT_ERROR_MESSAGES,
  DatabaseError,
  describeDatabaseError,
  isDatabaseError,
} from "./errors.js";

describe("DatabaseError", () => {
  it("has a safe default message for every code", () => {
    for (const code of DATABASE_ERROR_CODES) {
      expect(new DatabaseError(code).message).toBe(DEFAULT_ERROR_MESSAGES[code]);
      expect(DEFAULT_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    }
  });

  it("keeps the cause for debugging but never serialises it", () => {
    const driverError = new Error(
      'password authentication failed for user "alice" at db.internal:5432',
    );
    const error = new DatabaseError("authentication_failed", { cause: driverError });

    expect(error.cause).toBe(driverError); // available to server-side logging
    const json = JSON.stringify(error);
    expect(json).not.toContain("alice");
    expect(json).not.toContain("db.internal");
    expect(JSON.parse(json)).toEqual({
      code: "authentication_failed",
      message: DEFAULT_ERROR_MESSAGES.authentication_failed,
    });
  });

  it("is recognised by isDatabaseError", () => {
    expect(isDatabaseError(new DatabaseError("timeout"))).toBe(true);
    expect(isDatabaseError(new Error("x"))).toBe(false);
    expect(isDatabaseError({ code: "timeout" })).toBe(false);
  });
});

describe("describeDatabaseError", () => {
  it("passes through the code and message of our own errors", () => {
    expect(describeDatabaseError(new DatabaseError("ssl_error"))).toEqual({
      code: "ssl_error",
      message: DEFAULT_ERROR_MESSAGES.ssl_error,
    });
  });

  it("hides the details of any other error", () => {
    const leaky = new Error(
      "connect ECONNREFUSED 10.0.0.5:5432 for postgres://u:secret@10.0.0.5/db",
    );
    const described = describeDatabaseError(leaky);
    expect(described.code).toBe("unexpected");
    expect(JSON.stringify(described)).not.toContain("secret");
    expect(JSON.stringify(described)).not.toContain("10.0.0.5");
  });

  it("copes with non-Error throwables", () => {
    expect(describeDatabaseError("boom").code).toBe("unexpected");
    expect(describeDatabaseError(undefined).code).toBe("unexpected");
  });
});
