/** The CLI and the web app must agree on where the data folder is. */
import { describe, expect, it } from "vitest";
import { resolveDataDir as cli } from "../packages/cli/src/data-dir";
import { resolveDataDir as web } from "../apps/web/lib/server/storage/data-dir";

describe("data folder resolution", () => {
  it.each([
    [{}, "/home/u"],
    [{ DATACANVAS_HOME: "/data/dc" }, "/home/u"],
    [{ DATACANVAS_HOME: "  " }, "/home/u"],
    [{ DATACANVAS_HOME: "relative/dir" }, "/home/u"],
  ])("CLI and web app agree for %j", (env, home) => {
    expect(cli(env, home)).toBe(web(env, home));
  });
});
