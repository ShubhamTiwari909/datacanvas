/**
 * The text a person pastes to connect a Claude app to DataCanvas (`docs/mcp-server-plan.md`, section 5.3). It never holds a
 * token: the bridge `datacanvas mcp` finds the running DataCanvas and its token itself, so this text is the same on every run.
 */

export const PACKAGE_NAME = "@shubhamtiwari909/datacanvas";

/** Claude Code: one command, once. */
export const CLAUDE_CODE_COMMAND = `claude mcp add datacanvas -- npx --yes ${PACKAGE_NAME} mcp`;

/** The server entry every client below starts: the same bridge, so no client holds anything that changes between runs. */
const ARGS = ["--yes", PACKAGE_NAME, "mcp"];
const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** Claude Desktop: the entry of `claude_desktop_config.json`. */
export const CLAUDE_DESKTOP_CONFIG = json({
  mcpServers: { datacanvas: { command: "npx", args: ARGS } },
});

/** Claude Code, shared with a team: the `.mcp.json` file at the root of a project (the same entry as Claude Desktop's). */
export const CLAUDE_CODE_PROJECT_FILE = json({
  mcpServers: { datacanvas: { command: "npx", args: ARGS } },
});

/** Cursor: `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for every project. */
export const CURSOR_CONFIG = json({
  mcpServers: { datacanvas: { type: "stdio", command: "npx", args: ARGS } },
});

/** VS Code: `.vscode/mcp.json` in a workspace. Its top-level key is `servers`, not `mcpServers`. */
export const VSCODE_CONFIG = json({
  servers: { datacanvas: { type: "stdio", command: "npx", args: ARGS } },
});

export interface SetupClient {
  /** The value of the picker's option. */
  id: "claude-code" | "claude-code-project" | "claude-desktop" | "cursor" | "vscode";
  /** The option's text. */
  label: string;
  /** One line: where the text goes and what to do next. */
  where: string;
  /** The text to paste. Never a token, a port or a secret. */
  text: string;
  /** The accessible name of the text box (end-to-end tests look it up by this name). */
  boxLabel: string;
  /** The accessible name of the copy button. */
  copyLabel: string;
}

/**
 * The apps a person can connect, in the order of the picker. Claude Code is the first (the default). Each file format was
 * checked against the app's own documentation (2026-11): Claude Code's `claude mcp add` and project `.mcp.json`, Cursor's
 * `.cursor/mcp.json` (its field table lists `type`, its examples leave it out) and VS Code's `servers` file (`type` is
 * required there). A format can change, so the dialog says where to look when a file is not accepted.
 */
export const SETUP_CLIENTS: readonly SetupClient[] = [
  {
    id: "claude-code",
    label: "Claude Code (one command)",
    where: "Run this once in a terminal.",
    text: CLAUDE_CODE_COMMAND,
    boxLabel: "Command for Claude Code",
    copyLabel: "Copy the command for Claude Code",
  },
  {
    id: "claude-code-project",
    label: "Claude Code (shared with a project)",
    where:
      "Save this as .mcp.json at the root of the project and commit it. Claude Code asks each person to approve it once.",
    text: CLAUDE_CODE_PROJECT_FILE,
    boxLabel: "Project file for Claude Code",
    copyLabel: "Copy the project file for Claude Code",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    where: "Add this to claude_desktop_config.json, then restart Claude Desktop.",
    text: CLAUDE_DESKTOP_CONFIG,
    boxLabel: "Config for Claude Desktop",
    copyLabel: "Copy the config for Claude Desktop",
  },
  {
    id: "cursor",
    label: "Cursor",
    where:
      "Save this as .cursor/mcp.json in a project, or as ~/.cursor/mcp.json for every project.",
    text: CURSOR_CONFIG,
    boxLabel: "Config for Cursor",
    copyLabel: "Copy the config for Cursor",
  },
  {
    id: "vscode",
    label: "VS Code",
    where:
      "Save this as .vscode/mcp.json in the workspace (VS Code names the list servers, not mcpServers). Newer VS Code agent setups can read other files: check its MCP documentation.",
    text: VSCODE_CONFIG,
    boxLabel: "Config for VS Code",
    copyLabel: "Copy the config for VS Code",
  },
];

/** What the person is told when a file is not accepted: the formats are the apps', and apps change them. */
export const SETUP_FORMAT_NOTE =
  "If an app does not accept the file, check its MCP documentation: the file formats are the apps' and can change. What never changes is the command: npx --yes " +
  `${PACKAGE_NAME} mcp.`;

/** What the person is told about what leaves the machine, in the words of the plan. */
export const LEAVES_THE_MACHINE =
  "Anything Claude reads here is sent to Anthropic by the Claude app you use. DataCanvas cannot stop that or take it back.";

/** What the person is told about the hint of hidden columns. */
export const HIDDEN_COLUMNS_NOTE =
  "Columns whose names look sensitive are left out of what DataCanvas hands to Claude, but that is a safety net against accidents, not a barrier: a model that is told to can get around it with a crafted query. Use a database user that cannot read what must not leave. A Claude app that can run commands on this computer can also reach the app's own controls, so the approval prompt protects against mistakes, not against such an app.";
