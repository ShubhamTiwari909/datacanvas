import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_COMMAND,
  CLAUDE_DESKTOP_CONFIG,
  LEAVES_THE_MACHINE,
  PACKAGE_NAME,
} from "./setup-text";

describe("the text a person pastes", () => {
  it("is the command for Claude Code and a config for Claude Desktop that start the bridge, with no token", () => {
    expect(CLAUDE_CODE_COMMAND).toBe(`claude mcp add datacanvas -- npx --yes ${PACKAGE_NAME} mcp`);
    const config = JSON.parse(CLAUDE_DESKTOP_CONFIG) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers["datacanvas"]).toEqual({
      command: "npx",
      args: ["--yes", PACKAGE_NAME, "mcp"],
    });
    for (const text of [CLAUDE_CODE_COMMAND, CLAUDE_DESKTOP_CONFIG]) {
      expect(text).not.toMatch(/token|Bearer|localhost|127\.0\.0\.1|:\d{4}/i);
    }
  });

  it("says what leaves the machine, in the words of the plan", () => {
    expect(LEAVES_THE_MACHINE).toMatch(/sent to Anthropic by the Claude app you use/);
    expect(LEAVES_THE_MACHINE).toMatch(/cannot stop that or take it back/);
  });
});
