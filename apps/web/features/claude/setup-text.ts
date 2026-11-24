/**
 * The text a person pastes to connect a Claude app to DataCanvas (`docs/mcp-server-plan.md`, section 5.3). It never holds a
 * token: the bridge `datacanvas mcp` finds the running DataCanvas and its token itself, so this text is the same on every run.
 */

export const PACKAGE_NAME = "@shubhamtiwari909/datacanvas";

/** Claude Code: one command, once. */
export const CLAUDE_CODE_COMMAND = `claude mcp add datacanvas -- npx --yes ${PACKAGE_NAME} mcp`;

/** Claude Desktop: the entry of `claude_desktop_config.json`. */
export const CLAUDE_DESKTOP_CONFIG = JSON.stringify(
  { mcpServers: { datacanvas: { command: "npx", args: ["--yes", PACKAGE_NAME, "mcp"] } } },
  null,
  2,
);

/** What the person is told about what leaves the machine, in the words of the plan. */
export const LEAVES_THE_MACHINE =
  "Anything Claude reads here is sent to Anthropic by the Claude app you use. DataCanvas cannot stop that or take it back.";

/** What the person is told about the hint of hidden columns. */
export const HIDDEN_COLUMNS_NOTE =
  "Columns whose names look sensitive are left out of what DataCanvas hands to Claude, but that is a safety net against accidents, not a barrier: a model that is told to can get around it with a crafted query. Use a database user that cannot read what must not leave. A Claude app that can run commands on this computer can also reach the app's own controls, so the approval prompt protects against mistakes, not against such an app.";
