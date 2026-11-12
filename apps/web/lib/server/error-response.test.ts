import { DATABASE_ERROR_CODES, DatabaseError } from "@datacanvas/database-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATABASE_ERROR_STATUS, handleRoute, toErrorResponse } from "./error-response";
import { ServiceError } from "./service-error";

afterEach(() => vi.restoreAllMocks());

describe("toErrorResponse", () => {
  it("has an HTTP status for every database error code", () => {
    for (const code of DATABASE_ERROR_CODES) {
      expect(DATABASE_ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
    }
  });

  it.each([
    ["authentication_failed", 400],
    ["ssl_error", 400],
    ["not_found", 404],
    ["unreachable", 502],
    ["timeout", 504],
  ] as const)(
    "maps database error %s to status %i with the standard shape",
    async (code, status) => {
      const response = toErrorResponse(new DatabaseError(code));
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
    },
  );

  it("maps service errors", () => {
    expect(toErrorResponse(new ServiceError("connection_not_found", "gone")).status).toBe(404);
    expect(toErrorResponse(new ServiceError("connection_limit_reached", "full")).status).toBe(409);
  });

  it("turns unknown errors into a generic 500 that reveals nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const leaky = new Error("connect failed for postgres://alice:s3cret@10.0.0.5/shop");
    const response = toErrorResponse(leaky);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe("unexpected");
    for (const secret of ["alice", "s3cret", "10.0.0.5", "shop"])
      expect(text).not.toContain(secret);
  });

  it("logs only names and codes, never the error message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = Object.assign(new Error("password authentication failed for user alice"), {
      code: "28P01",
    });
    toErrorResponse(new DatabaseError("unexpected", { cause }));
    toErrorResponse(new Error("secret message with s3cret"));

    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("28P01");
    expect(logged).not.toContain("alice");
    expect(logged).not.toContain("s3cret");
  });

  it("handleRoute converts thrown errors and passes responses through", async () => {
    const ok = await handleRoute(async () => Response.json({ fine: true }));
    expect(ok.status).toBe(200);
    const failed = await handleRoute(async () => {
      throw new DatabaseError("timeout");
    });
    expect(failed.status).toBe(504);
  });
});
