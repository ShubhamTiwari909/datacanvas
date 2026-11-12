import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns 200 with the expected body", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", application: "datacanvas" });
  });

  it("is marked as non-cacheable", () => {
    expect(GET().headers.get("Cache-Control")).toBe("no-store");
  });
});
