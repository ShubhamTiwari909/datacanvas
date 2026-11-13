/**
 * Release gate: refuses to continue while anything a public release needs is
 * missing. It reads the assembled package (`npm run package` first) and the
 * repository, and prints every blocker, not just the first.
 *
 * It decides nothing for the maintainer: choosing a license, a repository
 * address or a contact is a human decision, so those are reported, never
 * filled in. Run with `npm run release:check`.
 */
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blockers = [];
const notes = [];

const exists = (file) =>
  stat(path.join(root, file)).then(
    () => true,
    () => false,
  );

async function main() {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(root, ".package/package.json"), "utf8"));
  } catch {
    console.error("Run `npm run package` first: .package/package.json does not exist.");
    process.exit(1);
  }

  if (!/^(@[a-z0-9-]+\/)?datacanvas$/.test(pkg.name))
    blockers.push(
      `package name is "${pkg.name}", expected "datacanvas" or "@<your-scope>/datacanvas"`,
    );
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version) || pkg.version === "0.0.0") {
    blockers.push(
      `version is ${pkg.version}; set a real version (for example 1.0.0-rc.1 or 1.0.0)`,
    );
  }
  if (!pkg.license)
    blockers.push('no "license" in the root package.json (the maintainer must choose one)');
  if (!(await exists("LICENSE")) && !(await exists("LICENSE.md"))) {
    blockers.push("no LICENSE file in the repository");
  }
  if (!pkg.repository) blockers.push('no "repository" in the root package.json');
  if (!pkg.bugs && !pkg.repository) blockers.push('no "bugs" address in the root package.json');
  if (!pkg.engines?.node) blockers.push('no "engines.node"');
  if (!pkg.bin?.datacanvas) blockers.push('no "bin.datacanvas"');
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (pkg.scripts?.[script]) blockers.push(`the package defines a ${script} script`);
  }

  for (const file of ["NOTICE", "THIRD-PARTY-NOTICES.md"]) {
    if (!(await exists(file)))
      blockers.push(`no ${file} (run \`npm run notices\` for the notices file)`);
  }

  const security = await readFile(path.join(root, "SECURITY.md"), "utf8");
  if (/a contact address will be added/i.test(security)) {
    blockers.push("SECURITY.md still has the placeholder for the vulnerability contact");
  }

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  if (
    /## \[Unreleased\]/.test(changelog) &&
    pkg.version !== "0.0.0" &&
    !changelog.includes(`[${pkg.version}]`)
  ) {
    blockers.push(`CHANGELOG.md has no section for ${pkg.version} (rename "Unreleased")`);
  }

  // Open items that are recorded elsewhere and need a human answer.
  const decisions = await readFile(path.join(root, "docs/decisions.md"), "utf8");
  if (/EPL-2\.0 OR GPL-3\.0/.test(decisions)) {
    notes.push(
      "elkjs license (EPL-2.0 OR GPL-3.0-or-later): confirm with the relevant internal team",
    );
  }

  // Is the name free on the registry? (A network call that sends only the package name.)
  try {
    execFileSync("npm", ["view", pkg.name, "version"], {
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    notes.push(
      `"${pkg.name}" already exists on npm (expected after the first publish; if you did not publish it, choose another name)`,
    );
  } catch (error) {
    const text = String(error.stderr ?? "");
    if (text.includes("E404"))
      notes.push(
        `"${pkg.name}" is not taken on npm right now (it can still be claimed by someone else before you publish)`,
      );
    else notes.push("could not check the npm registry (offline?)");
  }

  console.log(blockers.length === 0 ? "No blockers." : `${blockers.length} blocker(s):`);
  for (const blocker of blockers) console.log(`  BLOCKER  ${blocker}`);
  for (const note of notes) console.log(`  note     ${note}`);
  process.exit(blockers.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
