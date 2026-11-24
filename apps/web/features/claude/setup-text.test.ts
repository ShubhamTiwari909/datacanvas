import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_COMMAND,
  CLAUDE_CODE_PROJECT_FILE,
  CLAUDE_DESKTOP_CONFIG,
  CURSOR_CONFIG,
  LEAVES_THE_MACHINE,
  PACKAGE_NAME,
  SETUP_CLIENTS,
  SETUP_FORMAT_NOTE,
  VSCODE_CONFIG,
} from "./setup-text";

const ENTRY = { command: "npx", args: ["--yes", PACKAGE_NAME, "mcp"] };
const NO_SECRET = /token|Bearer|localhost|127\.0\.0\.1|:\d{4}|password|api[_-]?key/i;

describe("the text a person pastes", () => {
  it("is the command for Claude Code and a config for Claude Desktop that start the bridge, with no token", () => {
    expect(CLAUDE_CODE_COMMAND).toBe(`claude mcp add datacanvas -- npx --yes ${PACKAGE_NAME} mcp`);
    const config = JSON.parse(CLAUDE_DESKTOP_CONFIG) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers["datacanvas"]).toEqual(ENTRY);
    for (const text of [CLAUDE_CODE_COMMAND, CLAUDE_DESKTOP_CONFIG]) {
      expect(text).not.toMatch(NO_SECRET);
    }
  });

  it("is the same bridge, in each app's own file format", () => {
    // Claude Code's project file: the key is mcpServers, no type needed (an entry without one is stdio).
    expect(JSON.parse(CLAUDE_CODE_PROJECT_FILE)).toEqual({ mcpServers: { datacanvas: ENTRY } });
    // Cursor: mcpServers, with the stdio type its field table lists.
    expect(JSON.parse(CURSOR_CONFIG)).toEqual({
      mcpServers: { datacanvas: { type: "stdio", ...ENTRY } },
    });
    // VS Code: the key is `servers`, and `type` is required.
    expect(JSON.parse(VSCODE_CONFIG)).toEqual({
      servers: { datacanvas: { type: "stdio", ...ENTRY } },
    });
  });

  it("lists every app once, starts with Claude Code and keeps the names the end-to-end test looks up", () => {
    expect(SETUP_CLIENTS[0]?.id).toBe("claude-code");
    expect(new Set(SETUP_CLIENTS.map((c) => c.id)).size).toBe(SETUP_CLIENTS.length);
    expect(new Set(SETUP_CLIENTS.map((c) => c.boxLabel)).size).toBe(SETUP_CLIENTS.length);
    const names = Object.fromEntries(SETUP_CLIENTS.map((c) => [c.id, c.boxLabel]));
    expect(names["claude-code"]).toBe("Command for Claude Code");
    expect(names["claude-desktop"]).toBe("Config for Claude Desktop");
    // No label is a prefix of another that a lookup by name could confuse it with.
    for (const a of SETUP_CLIENTS) {
      for (const b of SETUP_CLIENTS) {
        if (a !== b) expect(b.boxLabel.startsWith(a.boxLabel)).toBe(false);
      }
    }
  });

  it("holds no token, port, secret or address anywhere, for any app", () => {
    for (const client of SETUP_CLIENTS) {
      expect(client.text, client.id).not.toMatch(NO_SECRET);
      expect(client.where, client.id).not.toMatch(NO_SECRET);
      expect(client.text, client.id).toContain(`npx`);
      expect(client.text, client.id).toContain(PACKAGE_NAME);
    }
    expect(SETUP_FORMAT_NOTE).not.toMatch(NO_SECRET);
  });

  it("says what leaves the machine, in the words of the plan", () => {
    expect(LEAVES_THE_MACHINE).toMatch(/sent to Anthropic by the Claude app you use/);
    expect(LEAVES_THE_MACHINE).toMatch(/cannot stop that or take it back/);
  });
});
