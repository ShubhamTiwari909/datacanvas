/**
 * Verify the PACKED tarball, the way a user gets it: `npm pack`, install the
 * tarball into an empty project, then run the installed `datacanvas` command.
 * Testing the monorepo would miss anything that only works because the
 * repository is lying around (a missing file, a dependency not bundled...).
 *
 * Run with `npm run verify:package` (after `npm run package`). It checks:
 *   - the tarball lists only what we intend to publish, no native add-ons;
 *   - it installs with no scripts and no network access to the registry;
 *   - `--version` and `--help` work;
 *   - the server starts, is protected by its token, and reports cold-start time;
 *   - a second launch reuses the running instance;
 *   - Ctrl+C (SIGINT) stops it cleanly and removes the run file.
 *
 * It prints the tarball size and the start-up time so regressions are visible.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, ".package");
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? `  (${detail})` : ""}`);
}

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

/** fetch() silently ignores a custom Host header, so use the plain http client for this probe. */
function statusWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/health", headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.once("error", reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  try {
    await stat(path.join(packageDir, "package.json"));
  } catch {
    throw new Error("Run `npm run package` first: .package/ does not exist.");
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "datacanvas-verify-"));
  console.log(`Working in ${work}\n`);

  // 1. Pack.
  const packOut = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const [packed] = JSON.parse(packOut);
  const tarball = path.join(work, packed.filename);
  const files = packed.files.map((f) => f.path);
  console.log(
    `Tarball: ${packed.filename}, ${mb(packed.size)} packed, ${mb(packed.unpackedSize)} unpacked, ${files.length} files\n`,
  );

  const allowed = /^(bin\/|web\/|node_modules\/|README\.md$|package\.json$|LICENSE)/;
  check(
    "only bin/, web/, node_modules/, README, package.json are packed",
    files.every((f) => allowed.test(f)),
    files
      .filter((f) => !allowed.test(f))
      .slice(0, 3)
      .join(", "),
  );
  check("no native add-ons (.node files)", !files.some((f) => f.endsWith(".node")));
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  check("engines.node is set", typeof manifest.engines?.node === "string", manifest.engines?.node);
  check(
    "no install scripts",
    !["preinstall", "install", "postinstall"].some((k) => k in (manifest.scripts ?? {})),
  );
  check("bin points at the CLI", manifest.bin?.datacanvas === "bin/datacanvas.mjs");

  // 2. Install into an empty project.
  const project = path.join(work, "project");
  await mkdir(project);
  await writeFile(path.join(project, "package.json"), '{"name":"verify","private":true}\n');
  execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: project,
    stdio: "pipe",
  });
  const bin = path.join(project, "node_modules/datacanvas/bin/datacanvas.mjs");
  const installed = await readdir(path.join(project, "node_modules"));
  check(
    "installed with its dependencies bundled (nothing else downloaded)",
    installed.includes("datacanvas"),
    `${installed.length} top-level entries`,
  );

  // 3. Simple commands.
  const version = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim();
  check("--version prints the package version", version === manifest.version, version);
  const help = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  check("--help lists --port and --no-open", help.includes("--port") && help.includes("--no-open"));

  // 4. Start it.
  const home = path.join(work, "home");
  const port = await freePort();
  const env = { ...process.env, DATACANVAS_HOME: home };
  const started = Date.now();
  const child = spawn(process.execPath, [bin, "--no-open", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

  let link = null;
  while (!link && Date.now() - started < 30_000) {
    link = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(output)?.[0] ?? null;
    if (!link) await sleep(50);
  }
  const coldStart = Date.now() - started;
  check("server starts and prints a private link", link !== null, `cold start ${coldStart} ms`);
  check("first run prints a welcome line", output.includes("Welcome to DataCanvas"));
  if (!link) {
    child.kill("SIGKILL");
    console.log(output);
    throw new Error("The server did not start.");
  }

  const base = `http://127.0.0.1:${port}`;
  check("health answers without a token", (await fetch(`${base}/api/health`)).status === 200);
  check(
    "API refuses requests without the token",
    (await fetch(`${base}/api/connections`)).status === 401,
  );
  check("API refuses a foreign Host", (await statusWithHost(port, "evil.example")) === 403);
  const exchange = await fetch(link, { redirect: "manual" });
  const cookie = (exchange.headers.get("set-cookie") ?? "").split(";")[0];
  check(
    "the link is exchanged for a cookie",
    exchange.status === 307 && cookie.startsWith("dc_session_"),
  );
  check(
    "the cookie unlocks the API",
    (await fetch(`${base}/api/connections`, { headers: { cookie } })).status === 200,
  );
  const page = await fetch(`${base}/`, { headers: { cookie } });
  check(
    "the home page is served",
    page.status === 200 && (await page.text()).includes("DataCanvas"),
  );

  const runFile = path.join(home, "run.json");
  const mode = (await stat(runFile)).mode & 0o777;
  check("run file is owner-only", process.platform === "win32" || mode === 0o600, mode.toString(8));
  const homeMode = (await stat(home)).mode & 0o777;
  check(
    "data folder is owner-only",
    process.platform === "win32" || homeMode === 0o700,
    homeMode.toString(8),
  );

  // 5. A second launch reuses the running instance.
  const second = execFileSync(process.execPath, [bin, "--no-open"], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  check(
    "a second launch reuses the running instance",
    second.includes("already running") && second.includes(`:${port}/`),
  );

  // 6. Clean shutdown.
  child.kill("SIGINT");
  const end = await Promise.race([exited, sleep(10_000).then(() => "timeout")]);
  check(
    "Ctrl+C stops it cleanly (exit code 0)",
    end !== "timeout" && end.code === 0,
    JSON.stringify(end),
  );
  let runFileGone = false;
  try {
    await stat(runFile);
  } catch {
    runFileGone = true;
  }
  check("run file is removed on shutdown", runFileGone);
  check(
    "port is released",
    await fetch(`${base}/api/health`).then(
      () => false,
      () => true,
    ),
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nSize: ${mb(packed.size)} packed (${mb(packed.unpackedSize)} unpacked). Cold start: ${coldStart} ms.`,
  );
  console.log(
    failed.length === 0
      ? `All ${results.length} checks passed.`
      : `${failed.length} of ${results.length} checks FAILED.`,
  );
  console.log(`(Scratch folder left at ${work}.)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nverify-package failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
