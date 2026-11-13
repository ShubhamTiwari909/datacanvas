/**
 * The Node.js version gate. Kept separate (and pure) so it can be tested with
 * made-up version strings, since a test cannot change the Node it runs on.
 */
export const MIN_NODE_MAJOR = 20;
/** Matches "engines" (>=20.9.0), the floor Next.js requires. */
export const MIN_NODE_MINOR = 9;

/** Is `version` (e.g. "20.9.0" or "22.1.3") new enough? Unparseable input is not supported. */
export function isSupportedNode(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    return false;
  }
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

/** The message shown when Node is too old. It says what to do, not just what is wrong. */
export function unsupportedNodeMessage(version: string): string {
  return (
    `DataCanvas needs Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer, but this is ${version}.\n` +
    "Install a current LTS version from https://nodejs.org and try again."
  );
}
