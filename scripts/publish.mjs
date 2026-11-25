/**
 * Publish DataCanvas to npm from your own machine, with guard rails.
 *
 *   pnpm run publish:npm                       # rehearsal: everything except the upload
 *   pnpm run publish:npm -- --publish          # really publish (asks for your 2FA code)
 *   pnpm run publish:npm -- --publish --otp=123456
 *
 * What it does, in order, stopping at the first problem:
 *   1. builds the package (`pnpm run package`) and tests the PACKED tarball
 *      (`pnpm run verify:package`);
 *   2. runs the release gate (`pnpm run release:check`): version, license,
 *      repository, security contact, changelog section;
 *   3. refuses if that exact version already exists on npm (a version can
 *      never be published twice);
 *   4. with --publish: refuses unless you are logged in to npm as the expected
 *      account (EXPECTED_NPM_USER below);
 *   5. runs `npm publish` from `.package/` (public). A pre-release version such
 *      as 1.0.0-rc.1 goes to the `next` tag, so `npx <package>` keeps
 *      resolving to the last stable version; a normal version goes to `latest`.
 *      Without --publish it adds --dry-run, which lists what would be uploaded.
 *
 * It never stores or prints credentials: `npm login` keeps them in your npm
 * configuration, and the two-factor code is typed into npm's own prompt (or
 * passed with --otp for this one run). It does not tag or push anything in git;
 * do that yourself afterwards (the final message shows the commands).
 *
 * Local publishing cannot attach npm provenance (that needs GitHub Actions'
 * identity). The tag-driven workflow in .github/workflows/release.yml does.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The npm account allowed to publish from this script (profile: npmjs.com/~shubhamtiwari909). */
const EXPECTED_NPM_USER = "shubhamtiwari909";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const reallyPublish = args.includes("--publish");
const otp = args.find((a) => a.startsWith("--otp="));
const unknown = args.filter((a) => a !== "--publish" && !a.startsWith("--otp="));
const shell = process.platform === "win32"; // npm is a .cmd file on Windows

function fail(message) {
  console.error(`\nSTOPPED: ${message}`);
  process.exit(1);
}

/** Run a command, streaming its output; stop the whole script if it fails. */
function step(title, command, commandArgs, options = {}) {
  console.log(`\n== ${title}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell,
    ...options,
  });
  if (result.status !== 0) fail(`"${[command, ...commandArgs].join(" ")}" failed.`);
}

/** Run a command quietly and return its output, or null if it fails. */
function capture(command, commandArgs, options = {}) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      shell,
      ...options,
    }).trim();
  } catch (error) {
    return { failed: true, stderr: String(error.stderr ?? "") };
  }
}

async function main() {
  if (unknown.length)
    fail(`unknown option(s): ${unknown.join(", ")}. Use --publish and optionally --otp=<code>.`);

  step("Build the package", "pnpm", ["run", "package"]);
  step("Test the packed tarball", "pnpm", ["run", "verify:package"]);
  step("Release gate", "pnpm", ["run", "release:check"]);

  const pkg = JSON.parse(await readFile(path.join(root, ".package/package.json"), "utf8"));
  const tag = pkg.version.includes("-") ? "next" : "latest";
  console.log(`\nPackage: ${pkg.name}@${pkg.version}  (npm tag: ${tag})`);

  // A version can only be published once, ever.
  const existing = capture("npm", ["view", `${pkg.name}@${pkg.version}`, "version"]);
  if (typeof existing === "string" && existing) {
    fail(
      `${pkg.name}@${pkg.version} is already on npm. Choose a new version in packages/cli/package.json.`,
    );
  }

  if (reallyPublish) {
    const user = capture("npm", ["whoami"]);
    if (typeof user !== "string" || !user) {
      fail(
        "you are not logged in to npm. Run `npm login` (use the account that owns the package), then try again.",
      );
    }
    if (user !== EXPECTED_NPM_USER) {
      fail(
        `logged in to npm as "${user}", but this script publishes as "${EXPECTED_NPM_USER}". Log in with the right account, or change EXPECTED_NPM_USER.`,
      );
    }
    console.log(`Logged in to npm as ${user}.`);
  } else {
    console.log("Rehearsal: nothing will be uploaded. Add --publish to publish for real.");
  }

  const publishArgs = ["publish", "./.package", "--access", "public", "--tag", tag];
  if (!reallyPublish) publishArgs.push("--dry-run");
  if (reallyPublish && otp) publishArgs.push(otp);
  step(reallyPublish ? "Publish to npm" : "Rehearse the publish (dry run)", "npm", publishArgs);

  if (!reallyPublish) {
    console.log("\nRehearsal finished. When you are ready:  pnpm run publish:npm -- --publish");
    return;
  }
  // `npm publish` exiting normally only means npm accepted the upload. A new
  // version can take a minute to show up (and npm may hold an upload for
  // approval), so wait for the registry to say it exists before claiming success.
  console.log("\nWaiting for the registry to list the new version (up to 2 minutes)...");
  let visible = false;
  for (let attempt = 0; attempt < 12 && !visible; attempt += 1) {
    const seen = capture("npm", ["view", `${pkg.name}@${pkg.version}`, "version"]);
    visible = typeof seen === "string" && seen === pkg.version;
    if (!visible) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!visible) {
    console.log(`
npm accepted the upload, but ${pkg.name}@${pkg.version} is not visible yet.
It may still be propagating, or npm may be waiting for you to approve it: check
https://www.npmjs.com/package/${pkg.name} and your npm notifications, then run:
  npm view ${pkg.name} dist-tags
Do NOT run this script again for the same version.
`);
    return;
  }
  console.log(`
Published ${pkg.name}@${pkg.version} under the "${tag}" tag, and the registry lists it.

Check it from a clean folder:
  npx --yes ${pkg.name}@${pkg.version} --version

Then record it in git (this script does not touch git):
  git tag v${pkg.version}
  git push origin v${pkg.version}
`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
