/**
 * Assemble the publishable `datacanvas` npm package into `.package/`.
 *
 * Run through `npm run package` (which first runs the normal build). Output:
 *
 *   .package/
 *   ├── bin/datacanvas.mjs       the CLI, bundled into one file (esbuild)
 *   ├── web/apps/web/...         Next.js standalone server + static assets
 *   ├── node_modules/            runtime dependencies of the server (bundled)
 *   ├── package.json             generated: name, bin, engines, bundleDependencies
 *   └── README.md
 *
 * Why node_modules sits at the package root and is listed in
 * `bundleDependencies`: `npm pack` never includes a nested `node_modules`
 * folder unless the packages are declared as bundled dependencies of the root
 * package. Node still finds them, because module resolution walks up from
 * web/apps/web/server.js through web/node_modules to <package>/node_modules.
 *
 * Guard rails (the build fails if they are violated):
 *   - no native add-ons (*.node files) may be shipped;
 *   - bundled packages must not define install/postinstall scripts.
 */
import { build } from "esbuild";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".package");
const standaloneDir = path.join(root, "apps/web/.next/standalone");
const staticDir = path.join(root, "apps/web/.next/static");
const publicDir = path.join(root, "apps/web/public");

/**
 * Optional packages that Next.js' tracer copies even though we never use them.
 * `sharp` is Next's native image optimiser (images are unoptimised in this app,
 * see apps/web/next.config.ts); the rest are its platform-specific helpers.
 */
const PRUNE = ["sharp", "@img", "@emnapi", "detect-libc"];

function fail(message) {
  console.error(`\nbuild-package failed: ${message}`);
  process.exit(1);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Yield every file path under `dir`. */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Names of the top-level packages in a node_modules folder, including @scope/name entries. */
async function listPackages(nodeModules) {
  const names = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const child of await readdir(path.join(nodeModules, entry.name))) {
        names.push(`${entry.name}/${child}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function main() {
  if (!(await exists(path.join(standaloneDir, "apps/web/server.js")))) {
    fail(
      "Next.js standalone output not found. Run `npm run build` first (or use `npm run package`).",
    );
  }

  // Start from a clean output folder. Safe: we only ever delete `.package`
  // directly under the repo root, never a user-supplied path.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // 1. Web app: server code (standalone/apps) and its static assets.
  await cp(path.join(standaloneDir, "apps"), path.join(outDir, "web/apps"), { recursive: true });
  const webAppDir = path.join(outDir, "web/apps/web");
  // Next.js does not copy these into standalone; the server expects them at these exact paths.
  await cp(staticDir, path.join(webAppDir, ".next/static"), { recursive: true });
  if (await exists(publicDir))
    await cp(publicDir, path.join(webAppDir, "public"), { recursive: true });

  // 2. Runtime dependencies, lifted to the package root (see header comment).
  const nodeModulesOut = path.join(outDir, "node_modules");
  await cp(path.join(standaloneDir, "node_modules"), nodeModulesOut, { recursive: true });
  for (const name of PRUNE)
    await rm(path.join(nodeModulesOut, name), { recursive: true, force: true });

  // 3. Guard rails.
  const nativeFiles = [];
  for await (const file of walk(outDir)) {
    if (file.endsWith(".node")) nativeFiles.push(path.relative(outDir, file));
  }
  if (nativeFiles.length > 0) {
    fail(
      `native add-ons would be shipped (breaks "just Node.js" install):\n  ${nativeFiles.join("\n  ")}`,
    );
  }
  const bundled = await listPackages(nodeModulesOut);
  /** name -> exact installed version; needed for the `dependencies` field (see step 5). */
  const bundledVersions = {};
  for (const name of bundled) {
    const pkg = JSON.parse(await readFile(path.join(nodeModulesOut, name, "package.json"), "utf8"));
    bundledVersions[name] = pkg.version;
    const scripts = pkg.scripts ?? {};
    const bad = ["preinstall", "install", "postinstall"].filter((key) => key in scripts);
    if (bad.length > 0)
      fail(`bundled package "${name}" defines install scripts: ${bad.join(", ")}`);
  }

  // 4. CLI: bundle packages/cli (and the shared-types workspace) into one file.
  const cliPkg = JSON.parse(await readFile(path.join(root, "packages/cli/package.json"), "utf8"));
  const cliOut = path.join(outDir, "bin/datacanvas.mjs");
  await build({
    entryPoints: [path.join(root, "packages/cli/src/index.ts")],
    outfile: cliOut,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
    define: { __DATACANVAS_VERSION__: JSON.stringify(cliPkg.version) },
    logLevel: "warning",
  });
  await chmod(cliOut, 0o755);

  // 5. package.json for the published package.
  const packageJson = {
    name: "datacanvas",
    version: cliPkg.version,
    description:
      "A local-first visual PostgreSQL explorer. Runs on your machine; nothing leaves it.",
    keywords: ["postgresql", "postgres", "database", "schema", "visualizer", "erd", "local-first"],
    type: "module",
    bin: { datacanvas: "bin/datacanvas.mjs" },
    files: ["bin", "web", "README.md"],
    engines: { node: ">=20.9.0" },
    // `npm pack` only bundles a package that is BOTH listed in `dependencies`
    // and named in `bundleDependencies`. Listing it in `dependencies` alone
    // would make npm download it on install; `bundleDependencies` tells npm
    // the copy inside the tarball is the one to use, so nothing is downloaded.
    dependencies: bundledVersions,
    bundleDependencies: bundled,
  };
  await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await cp(path.join(root, "README.md"), path.join(outDir, "README.md"));

  console.log(`Package assembled in ${path.relative(root, outDir)}/`);
  console.log(`  version:          ${packageJson.version}`);
  console.log(`  bundled packages: ${bundled.length}`);
  console.log("  native add-ons:   none");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
