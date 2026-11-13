import { describe, expect, it } from "vitest";
import { GET } from "./route";

const request = (headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:4747/api/health", { headers });

describe("GET /api/health", () => {
  it("returns 200 with the expected body", async () => {
    const response = GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", application: "datacanvas" });
  });

  it("is marked as non-cacheable", () => {
    expect(GET(request()).headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const response = GET(request({ host: "evil.example:4747" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });
});
