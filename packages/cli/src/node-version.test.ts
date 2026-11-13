import { describe, expect, it } from "vitest";
import { isSupportedNode, unsupportedNodeMessage } from "./node-version.js";

describe("isSupportedNode", () => {
  it.each(["20.9.0", "20.10.0", "21.0.0", "22.1.3", "24.0.0"])("accepts %s", (v) => {
    expect(isSupportedNode(v)).toBe(true);
  });

  it.each(["20.8.1", "20.0.0", "18.20.4", "16.0.0", "", "abc", "20"])("rejects %s", (v) => {
    expect(isSupportedNode(v)).toBe(false);
  });

  it("tells the user what to do", () => {
    const message = unsupportedNodeMessage("18.20.4");
    expect(message).toContain("20.9");
    expect(message).toContain("18.20.4");
    expect(message).toContain("nodejs.org");
  });
});
