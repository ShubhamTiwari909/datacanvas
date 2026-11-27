/**
 * Run the PostgreSQL tests against several PostgreSQL versions, one disposable
 * Docker container per version.
 *
 *   pnpm run test:pg-matrix                 # versions 12 to 18
 *   pnpm run test:pg-matrix -- 14 17        # only these
 *
 * For each version: start `postgres:<version>-alpine` on a free loopback port
 * (data lives only inside the container and disappears with it), wait until it
 * accepts connections, run the adapter's integration, odd-schema and
 * performance tests plus the service integration tests against it, then stop
 * and remove the container. A summary table is printed at the end.
 *
 * NEEDS: Docker running. The first run downloads each image (roughly 250 to
 * 400 MB each); later runs reuse them. Nothing outside the containers is
 * touched, and the server is bound to 127.0.0.1 only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["12", "13", "14", "15", "16", "17", "18"];
const PASSWORD = "testpass";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const docker = (args, options = {}) =>
  execFileSync("docker", args, { encoding: "utf8", ...options });

async function runOne(version) {
  const name = `datacanvas-pg-matrix-${version}-${process.pid}`;
  const port = await freePort();
  const started = Date.now();
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-p",
    `127.0.0.1:${port}:5432`,
    `postgres:${version}-alpine`,
  ]);
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      const probe = spawnSync(
        "docker",
        ["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"],
        { encoding: "utf8" },
      );
      ready = probe.status === 0;
      if (!ready) await sleep(500);
    }
    if (!ready) return { version, ok: false, note: "server did not become ready" };
    await sleep(1000); // pg_isready can answer during the image's own initialisation restart

    const serverVersion = docker([
      "exec",
      name,
      "psql",
      "-U",
      "postgres",
      "-Atc",
      "show server_version",
    ]).trim();
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        // All test workers share one local Docker server. Keep database setup
        // and test queries from overwhelming it on machines with many CPUs.
        "--maxWorkers=2",
        "packages/postgres-adapter",
        "apps/web/lib/server/connection-service.integration",
        "apps/web/features/paths",
      ],
      {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
        env: {
          ...process.env,
          DATACANVAS_TEST_PG_URL: `postgresql://postgres:${PASSWORD}@127.0.0.1:${port}/postgres?sslmode=disable`,
        },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const summary = /Tests\s+(.*)/.exec(output)?.[1]?.trim() ?? "no test summary";
    return {
      version,
      ok: result.status === 0,
      note: `server ${serverVersion}; ${summary}; ${Math.round((Date.now() - started) / 1000)} s`,
      failures: result.status === 0 ? "" : (result.error?.message ?? output.trim()),
    };
  } finally {
    try {
      docker(["stop", "-t", "2", name], { stdio: "pipe" });
    } catch {
      // already gone
    }
  }
}

const results = [];
for (const version of versions) {
  console.log(`PostgreSQL ${version}: starting...`);
  try {
    results.push(await runOne(version));
  } catch (error) {
    results.push({ version, ok: false, note: String(error.message ?? error).split("\n")[0] });
  }
  const last = results.at(-1);
  console.log(`PostgreSQL ${version}: ${last.ok ? "ok" : "FAILED"}  ${last.note}`);
  if (last.failures) console.log(last.failures);
}

console.log("\nSummary");
for (const r of results)
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  PostgreSQL ${r.version}  ${r.note}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
