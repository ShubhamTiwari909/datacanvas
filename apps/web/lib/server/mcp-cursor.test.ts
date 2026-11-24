import { describe, expect, it } from "vitest";
import { CursorSealer } from "./mcp-cursor";

const plain = Buffer.from(JSON.stringify({ k: ["TOKEN-ABC-123"] })).toString("base64url");

describe("a sealed cursor", () => {
  it("round-trips for its own scope, and shows nothing of the cursor", () => {
    const sealer = new CursorSealer();
    const sealed = sealer.seal(plain, "c1\0public\0keyed");
    expect(sealer.open(sealed, "c1\0public\0keyed")).toBe(plain);
    expect(sealed).not.toContain(plain);
    expect(Buffer.from(sealed, "base64url").toString("utf8")).not.toContain("TOKEN");
    expect(sealer.seal(plain, "c1\0public\0keyed")).not.toBe(sealed);
  });
  it("is refused for another table or connection, another run, a made-up cursor and a changed one", () => {
    const sealer = new CursorSealer();
    const sealed = sealer.seal(plain, "c1\0public\0keyed");
    expect(sealer.open(sealed, "c1\0public\0other")).toBeNull();
    expect(sealer.open(sealed, "c2\0public\0keyed")).toBeNull();
    expect(new CursorSealer().open(sealed, "c1\0public\0keyed")).toBeNull();
    expect(sealer.open(plain, "c1\0public\0keyed")).toBeNull();
    expect(sealer.open("", "x")).toBeNull();
    const flipped = Buffer.from(sealed, "base64url");
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
    expect(sealer.open(flipped.toString("base64url"), "c1\0public\0keyed")).toBeNull();
  });
});
