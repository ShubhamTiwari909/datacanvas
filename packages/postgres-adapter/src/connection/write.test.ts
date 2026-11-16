/**
 * The write transaction and the write error mapping, without a database.
 */
import { DatabaseError } from "@datacanvas/database-core";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { mapWriteError } from "./write-errors.js";
import { withWriteTransaction } from "./write.js";

interface FakeClient {
  log: Array<{ text: string; values?: unknown[] }>;
  released: unknown[];
}

/** A pool with one client that records what it is asked; `failOn` makes a statement throw. */
function fakePool(
  failOn: (text: string) => Error | null = () => null,
): { pool: Pool } & FakeClient {
  const log: FakeClient["log"] = [];
  const released: unknown[] = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      log.push(values ? { text, values } : { text });
      const error = failOn(text);
      if (error) throw error;
      return { rows: [], rowCount: text.startsWith("UPDATE") ? 1 : null };
    },
    release: (error?: unknown) => {
      released.push(error);
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, log, released };
}

const limits = { lockTimeoutMs: 3000, statementTimeoutMs: 15000 };

describe("withWriteTransaction", () => {
  it("begins, sets both timeouts locally, runs the work, commits and releases", async () => {
    const { pool, log, released } = fakePool();
    const result = await withWriteTransaction(pool, limits, async (db) => {
      const outcome = await db.query("UPDATE t SET a = $1", ["x"]);
      return outcome.rowCount;
    });
    expect(result).toBe(1);
    expect(log).toEqual([
      { text: "BEGIN" },
      {
        text: "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        values: ["3000", "15000"],
      },
      { text: "UPDATE t SET a = $1", values: ["x"] },
      { text: "COMMIT" },
    ]);
    expect(released).toEqual([undefined]);
  });

  it("rolls back when the work throws (a failed assertion), and rethrows it", async () => {
    const { pool, log, released } = fakePool();
    const assertion = new DatabaseError("row_changed");
    await expect(
      withWriteTransaction(pool, limits, async (db) => {
        await db.query("UPDATE t SET a = 1");
        throw assertion;
      }),
    ).rejects.toBe(assertion);
    expect(log.map((l) => l.text)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config"),
      "UPDATE t SET a = 1",
      "ROLLBACK",
    ]);
    expect(log.some((l) => l.text === "COMMIT")).toBe(false);
    expect(released).toEqual([undefined]);
  });

  it("rolls back when a statement fails", async () => {
    const boom = new Error("boom");
    const { pool, log } = fakePool((text) => (text.startsWith("UPDATE") ? boom : null));
    await expect(
      withWriteTransaction(pool, limits, (db) => db.query("UPDATE t SET a = 1")),
    ).rejects.toBe(boom);
    expect(log.at(-1)).toEqual({ text: "ROLLBACK" });
  });

  it("destroys the connection when the rollback itself fails", async () => {
    const boom = new Error("boom");
    const lost = new Error("connection lost");
    const { pool, released } = fakePool((text) =>
      text.startsWith("UPDATE") ? boom : text === "ROLLBACK" ? lost : null,
    );
    await expect(
      withWriteTransaction(pool, limits, (db) => db.query("UPDATE t SET a = 1")),
    ).rejects.toBe(boom);
    expect(released).toEqual([lost]); // release(error) tells the pool not to reuse it
  });

  it("rolls back when COMMIT fails (a deferred constraint)", async () => {
    const late = Object.assign(new Error("deferred"), { code: "23503" });
    const { pool, log } = fakePool((text) => (text === "COMMIT" ? late : null));
    await expect(withWriteTransaction(pool, limits, async () => 1)).rejects.toBe(late);
    expect(log.at(-1)).toEqual({ text: "ROLLBACK" });
  });
});

describe("mapWriteError", () => {
  const SECRET = "hunter2-SECRET-VALUE";
  /** A driver error as PostgreSQL would send it, its message and detail full of the value. */
  const pgError = (code: string, fields: Record<string, string> = {}) =>
    Object.assign(new Error(`duplicate key value "${SECRET}" violates something`), {
      code,
      detail: `Key (email)=(${SECRET}) already exists.`,
      ...fields,
    });

  it.each([
    ["23505", "unique_violation"],
    ["23503", "foreign_key_violation"],
    ["23502", "not_null_violation"],
    ["23514", "check_violation"],
    ["23P01", "check_violation"],
    ["22001", "invalid_value"],
    ["22003", "invalid_value"],
    ["22P02", "invalid_value"],
    ["22007", "invalid_value"],
    ["55P03", "locked"],
    ["40001", "retry"],
    ["40P01", "retry"],
    ["42501", "write_denied"],
    ["25006", "write_denied"],
    ["2BP01", "has_dependents"],
    ["42P07", "already_exists"],
    ["42701", "already_exists"],
    ["42710", "already_exists"],
    ["42P16", "invalid_change"],
    ["42830", "invalid_change"],
    ["42804", "invalid_change"],
    ["42846", "invalid_change"],
    ["0A000", "invalid_change"],
    ["42P01", "not_found"],
    ["42703", "not_found"],
    ["57014", "timeout"],
    ["XX000", "unexpected"],
    ["08006", "unreachable"],
  ])("SQLSTATE %s becomes %s, with a fixed message and no value", (sqlstate, code) => {
    const mapped = mapWriteError(
      pgError(sqlstate, { constraint: "users_email_key", column: "email", table: "users" }),
    );
    expect(mapped).toBeInstanceOf(DatabaseError);
    expect(mapped.code).toBe(code);
    expect(mapped.message).not.toContain(SECRET);
    expect(mapped.message).not.toContain("duplicate key value");
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
    expect(Object.keys(mapped)).not.toContain("cause");
  });

  it("names the constraint or the column, which are structure", () => {
    expect(mapWriteError(pgError("23505", { constraint: "users_email_key" })).message).toBe(
      "A row with the same value already exists (users_email_key). Nothing was changed.",
    );
    expect(mapWriteError(pgError("23505")).message).toBe(
      "A row with the same value already exists. Nothing was changed.",
    );
    expect(mapWriteError(pgError("23502", { column: "email" })).message).toBe(
      "email cannot be empty. Nothing was changed.",
    );
    expect(mapWriteError(pgError("23514", { constraint: "age_check" })).message).toContain(
      "(age_check)",
    );
    expect(mapWriteError(pgError("22001", { column: "name" })).message).toBe(
      "A value is not valid for name. Nothing was changed.",
    );
  });

  it("passes a DatabaseError through and maps anything else like a read", () => {
    const own = new DatabaseError("row_changed");
    expect(mapWriteError(own)).toBe(own);
    expect(mapWriteError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).code).toBe(
      "unreachable",
    );
    expect(mapWriteError("just a string").code).toBe("unexpected");
    expect(mapWriteError(null).code).toBe("unexpected");
  });
});
