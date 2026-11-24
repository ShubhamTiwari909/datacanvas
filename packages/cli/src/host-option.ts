/**
 * The `--host` option: which network interface the local server listens on.
 *
 * DataCanvas listens on loopback (127.0.0.1) and nowhere else, and that stays the default. The one exception is a
 * container: a port published by Docker reaches the program through the container's own network interface, not through the
 * container's loopback, so inside a container the server has to listen on all interfaces. That is allowed ONLY when the
 * environment says so (`DATACANVAS_ALLOW_ANY_INTERFACE=1`, which the Dockerfile sets and a person on a normal computer never
 * does), so a stray `--host` in a script or a shell history cannot expose the app to a network by itself.
 *
 * Even then nothing else is loosened: the Host check still accepts only `127.0.0.1:<port>` and `localhost:<port>`, and the
 * session token and the token of `/mcp` are still required, so a request that arrives through a LAN address is refused.
 * The only safe way to publish the port is to bind it to loopback on the host (`-p 127.0.0.1:4747:4747`).
 *
 * This is the one file of the CLI that may name the all-interfaces address (`tests/security.test.ts` pins that).
 */

export const LOOPBACK_HOST = "127.0.0.1";
export const ALL_INTERFACES_HOST = "0.0.0.0";

/** The environment variable that must be exactly "1" before the all-interfaces address is accepted. */
export const ALLOW_ANY_INTERFACE_ENV = "DATACANVAS_ALLOW_ANY_INTERFACE";

export type ServerHost = typeof LOOPBACK_HOST | typeof ALL_INTERFACES_HOST;

export type HostChoice = { ok: true; host: ServerHost } | { ok: false; message: string };

/** Turn the value of `--host` (undefined when not given) into the address to listen on, or into a refusal in plain words. */
export function resolveHost(
  value: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostChoice {
  if (value === undefined || value === LOOPBACK_HOST) return { ok: true, host: LOOPBACK_HOST };
  if (value === ALL_INTERFACES_HOST) {
    if (env[ALLOW_ANY_INTERFACE_ENV] === "1") return { ok: true, host: ALL_INTERFACES_HOST };
    return {
      ok: false,
      message:
        `--host ${ALL_INTERFACES_HOST} is refused: it would let other computers on your network reach DataCanvas. ` +
        `It is meant for a container, where a published port needs it: the Docker image sets ${ALLOW_ANY_INTERFACE_ENV}=1 for that. ` +
        `On your own computer leave --host out (DataCanvas then listens on ${LOOPBACK_HOST} only).`,
    };
  }
  return {
    ok: false,
    message: `--host must be ${LOOPBACK_HOST} or ${ALL_INTERFACES_HOST} (got "${value}").`,
  };
}
