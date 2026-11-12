import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

describe("unknown /api/* routes", () => {
  it("return the standard JSON error shape with status 404", async () => {
    const response = GET();
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "This API endpoint does not exist." },
    });
  });

  it("answers other HTTP methods the same way", () => {
    expect(POST().status).toBe(404);
  });
});
