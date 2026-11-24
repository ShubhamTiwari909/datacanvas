# DataCanvas in Docker, and starting it without a person at the keyboard

DataCanvas is a local tool: it listens on `127.0.0.1` only and prints a private link. This page is for two cases that need a little more: running it in a **container**, and starting it from a **script or an agent** where nobody is there to click.

Nothing here weakens the protections. Inside a container the program has to listen on all of the container's interfaces (a published port reaches it through the container's own network interface, not its loopback). That is allowed **only** when the environment says so, and everything else still applies: the Host check (`127.0.0.1:<port>` and `localhost:<port>` only), the private session token and the separate token of `/mcp`. A request that arrives through any other address is refused (tested, see the end of this page).

## Build and run

The image is built from the packaged app, so build that first (this needs a clone of the repository and Node.js 20.19 or newer; the image itself uses `node:22-alpine`):

```bash
npm install
npm run package          # makes .package/ (the same folder npm publishes)
docker build -t datacanvas .
```

Run it:

```bash
docker run --rm \
  -p 127.0.0.1:4747:4747 \
  -v datacanvas-data:/data \
  datacanvas
```

The container prints the link, with this run's token:

```text
DataCanvas is running. Open this link in your browser:
  http://127.0.0.1:4747/?token=...
```

Open that link in a browser **on the same computer** (`docker logs <container>` shows it again). Press Ctrl+C, or `docker stop`, to stop it; it closes its database connections first and exits with code 0.

What the image does:

- Runs as the non-root user `node`.
- `DATACANVAS_HOME=/data` is a volume: connection profiles (without passwords), workspaces and snapshots live there. The named volume above keeps them between runs.
- `ENV DATACANVAS_ALLOW_ANY_INTERFACE=1` and the default arguments `--host 0.0.0.0 --no-open --port 4747`. The command `datacanvas` is on the `PATH`.
- Anything after the image name replaces the default arguments, so to change the port give them all: `datacanvas --host 0.0.0.0 --no-open --port 8080`.

### Publish the port to 127.0.0.1 only

Always write `-p 127.0.0.1:4747:4747`, never `-p 4747:4747`. Without the `127.0.0.1:` Docker publishes the port on **every** interface of your computer, which makes the app reachable from your network (and Docker does this around many firewalls). The Host check and the token would still refuse a stranger, but a protection that was never meant to face a network should not have to. DataCanvas prints this reminder at start-up when it listens on all interfaces.

### Keep the two port numbers equal

The Host check accepts only `127.0.0.1:<port>` and `localhost:<port>` with **the port the program listens on**. If you publish `-p 127.0.0.1:8080:4747` the browser sends `Host: 127.0.0.1:8080`, and DataCanvas answers 403. Use the same number on both sides, and give the program that number:

```bash
docker run --rm -p 127.0.0.1:8080:8080 -v datacanvas-data:/data \
  datacanvas --host 0.0.0.0 --no-open --port 8080
```

### A folder on your computer instead of a named volume

A named volume (above) just works. With a bind mount (`-v "$PWD/dc-data:/data"`) the folder must be writable by the user the container runs as, or DataCanvas cannot save anything, and the `datacanvas mcp` bridge will not find the running app. Run the container as yourself:

```bash
mkdir -p dc-data
docker run --rm --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:4747:4747 -v "$PWD/dc-data:/data" datacanvas
```

## Reaching a database on your computer

Inside the container `127.0.0.1` is the container, not your computer. Use the host name `host.docker.internal`:

- Docker Desktop (macOS, Windows) knows it already.
- On Linux add it: `docker run ... --add-host=host.docker.internal:host-gateway ...`.

In **Connect PostgreSQL** enter host `host.docker.internal` and your database's port. Two things follow from that name not being `localhost`:

- **TLS.** DataCanvas treats every host except `localhost`, `127.0.0.1` and `::1` as remote and proposes **Encrypted and verified**. A PostgreSQL on your own computer without TLS needs the **Off** option for SSL (a local test database only; use encryption for anything else).
- **Reading only.** Editing (`--enable-writes`) is allowed only on a loopback host, so through a container DataCanvas stays read-only.

The PostgreSQL server must accept the connection from the container: it has to listen on an address Docker's network can reach, and `pg_hba.conf` must allow it. A database that is itself a container can be reached by putting both on one Docker network (`--network`) and using its container name as the host.

## Share with Claude from a container

**Share with Claude** works with a container, with one thing to know. The bridge that a Claude app starts (`npx --yes @shubhamtiwari909/datacanvas mcp`) does not know where DataCanvas runs. It finds it through `mcp.json`, a small file (mode 0600) that the running DataCanvas writes into its data folder and removes when it stops. It holds the port and the token of `/mcp`, which change on every start, so they cannot be in an editor's config file. The bridge reads it from `DATACANVAS_HOME` (`~/.datacanvas` if that is not set), so **the bridge must look at the same data folder as the container.** There are two ways.

### A. Start the bridge inside the container (recommended)

`docker exec -i` runs the bridge in the container, where it sees `/data/mcp.json` and the app on `127.0.0.1`. The setup text for a Claude app becomes:

```text
claude mcp add datacanvas -- docker exec -i <container> datacanvas mcp
```

or, in a JSON config (Claude Desktop, Cursor and the like; for VS Code use the `servers` key and `"type": "stdio"`):

```json
{
  "mcpServers": {
    "datacanvas": {
      "command": "docker",
      "args": ["exec", "-i", "<container>", "datacanvas", "mcp"]
    }
  }
}
```

Start the container with a name (`docker run --name datacanvas ...`) and use that name. `-i` is required (the bridge talks over stdin and stdout) and `-t` must **not** be used. If the container is not running, or nothing is shared, the bridge answers in plain words that DataCanvas is not running or no connection is shared.

Checked on Docker 27 against a PostgreSQL on the host: with a connection shared at the structure level, a stdio client sending `initialize`, `tools/list` and `tools/call` through `docker exec -i <container> datacanvas mcp` received the server's answers, including the tools of the structure level and the list of shared connections.

### B. Start the usual bridge on your computer

If the data folder is a bind mount (see above, with `--user`) and the published port is the same on both sides, the ordinary command works on your computer, as long as it is told which folder to read:

```bash
DATACANVAS_HOME="$PWD/dc-data" npx --yes @shubhamtiwari909/datacanvas mcp
```

In a JSON config put it in `env`: `"env": { "DATACANVAS_HOME": "/full/path/to/dc-data" }`. The bridge then calls `127.0.0.1:<port>` on your computer, which Docker forwards to the container. Checked the same way (a bind mount, the same port number on both sides, the bridge started on the host).

What leaves your computer is the same in both cases: **what Claude reads is sent to Anthropic by the Claude app**, and you approve each data call in DataCanvas. Read [SECURITY.md](../SECURITY.md) first.

## Starting without a person: scripts, CI and agents

Everything the interactive start does works without a terminal:

```bash
npx --yes @shubhamtiwari909/datacanvas --no-open --port 4747
```

- `--no-open` does not try to open a browser (a headless machine has none).
- `--port <number>` makes the port predictable. The port you ask for is honoured exactly: if it is busy the start fails with a message and a non-zero exit code. Without `--port` DataCanvas takes 4747 or the next free port and says which.
- `DATACANVAS_HOME=<folder>` chooses the data folder (default `~/.datacanvas`). Give each environment its own folder to keep profiles, workspaces and the `mcp.json` of one run apart from another.
- The **link is on standard output**, as the line after `DataCanvas is running. Open this link in your browser:`. It has this run's token. Read it from there; nothing else prints a token. Treat it like a password for as long as the program runs, and do not write it to a shared log.

A small example that starts it, waits for the link and keeps the process in the background:

```bash
DATACANVAS_HOME="$PWD/.dc" npx --yes @shubhamtiwari909/datacanvas --no-open --port 4747 > dc.log 2>&1 &
until grep -q 'token=' dc.log; do sleep 0.5; done
LINK=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' dc.log | head -1)
```

- The program exits with 0 after Ctrl+C or SIGTERM, 1 on a failure (busy port, unsupported Node version, bad option).
- A second start with the same data folder finds the running one and prints its link instead of starting another (`already running`), unless `--port` names a different port.
- `--help` lists every option.

### The `--host` option

`--host <127.0.0.1|0.0.0.0>` chooses the interface to listen on. The default is `127.0.0.1` and it is the only choice on a normal computer: `--host 0.0.0.0` is refused unless the environment variable `DATACANVAS_ALLOW_ANY_INTERFACE=1` is set, which the Dockerfile does and nothing else does. The printed link is always `http://127.0.0.1:<port>/?token=...`.

## Checked

Built and run with Docker 27.4 on macOS (Docker Desktop), against a disposable local PostgreSQL:

- the container starts as the user `node`, prints the link, and answers `/api/health` with 200 on the published loopback port;
- a request with `Host: evil.example:<port>` gets 403; a request from inside the container to its own non-loopback address (so the process does listen on all interfaces) gets 403; `/api/connections` without the cookie gets 401, with the cookie from the first page load 200; `/mcp` without the bearer token gets 401;
- publishing a different host port (`-p 127.0.0.1:47471:4747`) gets 403, as described above;
- it connected to a PostgreSQL on the host through `host.docker.internal` (with SSL **Off**), shared it, and the bridge through `docker exec -i` answered `initialize`, `tools/list` and `tools/call`;
- the bridge started on the host with `DATACANVAS_HOME` pointing at a bind-mounted folder (the container run with `--user`) answered a `tools/call`;
- `docker stop` stops it in well under a second with exit code 0.

Not checked: Linux hosts (the `--add-host` line is from Docker's documentation), Windows, and a `docker compose` file.
