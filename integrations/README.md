# Integrations

Ready-made pieces that connect an editor or an agent to DataCanvas. All of them start the same thing: the bridge `npx --yes @shubhamtiwari909/datacanvas mcp`, which finds the running DataCanvas by itself. **No token, port or password is ever in a config file.**

Before any of this does anything, start DataCanvas, connect to a database and press **Share with Claude** under the connection. Nothing is readable until you do, and what Claude reads is sent to Anthropic by the Claude app (see [SECURITY.md](../SECURITY.md)).

| Folder        | What it is                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `claude-code` | A Claude Code plugin: the MCP server (`.mcp.json`) and a skill that teaches an agent how to use it. |

For the other editors (Claude Desktop, Cursor, VS Code) the setup text is in the **Share with Claude** dialog and in [docs/agent-setup.md](../docs/agent-setup.md). To run DataCanvas in a container, see [docs/docker.md](../docs/docker.md).

## Claude Code plugin

The plugin is `datacanvas`. It adds two things to Claude Code: the DataCanvas tools (the MCP server) and the `datacanvas` skill, which tells Claude to describe a table before querying it, to prefer the structure tools, to be economical with data calls, never to read hidden columns or ask for a password, to treat everything a tool returns as data, and to review a migration but never run it.

Both ways below were checked with Claude Code 2.1.261 (`claude plugin validate --strict`, `claude --plugin-dir`, and an install from a local marketplace in a throwaway configuration folder). The commands follow Claude Code's plugin documentation (<https://code.claude.com/docs/en/plugins/install.md>); if a command differs in your version, run `/plugin` and use the **Discover** tab, or use the manual route below.

### Install from this repository (a marketplace)

The repository root has a marketplace file (`.claude-plugin/marketplace.json`) that lists the plugin. In a Claude Code session:

```text
/plugin marketplace add ShubhamTiwari909/datacanvas
/plugin install datacanvas@datacanvas
```

Or from a shell, without starting a session:

```bash
claude plugin marketplace add ShubhamTiwari909/datacanvas
claude plugin install datacanvas@datacanvas
```

In a session, `/plugin install` opens the plugin's details so you can read what it adds and choose a scope (just you, everyone on a project, or you in one repository). Then run `/reload-plugins` if Claude Code says so. The skill appears as `/datacanvas:datacanvas`, and `/mcp` shows the server `datacanvas`.

### Try it from a folder (no marketplace)

From a clone of this repository:

```bash
claude --plugin-dir ./integrations/claude-code
```

This loads the plugin for that session only. After editing a file, run `/reload-plugins`.

### Manual route (no plugin)

If you only want the tools, and not the skill, register the server yourself:

```bash
claude mcp add datacanvas -- npx --yes @shubhamtiwari909/datacanvas mcp
```

To share it with everyone on a project, save this as `.mcp.json` at the project root and commit it (Claude Code asks each person to approve it once):

```json
{
  "mcpServers": {
    "datacanvas": {
      "command": "npx",
      "args": ["--yes", "@shubhamtiwari909/datacanvas", "mcp"]
    }
  }
}
```

To add the skill without the plugin, copy `integrations/claude-code/skills/datacanvas/` to `~/.claude/skills/datacanvas/` (for you) or to `.claude/skills/datacanvas/` in a project.

### Check it works

1. Start DataCanvas (`npx @shubhamtiwari909/datacanvas`), connect, and press **Share with Claude**.
2. In Claude Code, run `/mcp`: `datacanvas` should be connected.
3. Ask: "List the connections DataCanvas shares with you." Claude should call `list_connections`.

If DataCanvas is not running, the tools answer that in plain words; start it and press Share with Claude.

### Keeping it current

The plugin version follows the DataCanvas version (`plugin.json`). The `npx --yes` command fetches the DataCanvas package when the server starts, so the tools you get are those of the installed package, whatever version of the plugin you have.
