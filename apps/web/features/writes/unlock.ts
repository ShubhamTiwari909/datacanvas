/**
 * The words of the unlock dialog about the address the SERVER reports for the
 * database. That address is the main check against a tunnel or proxy on
 * 127.0.0.1 that leads to a remote database, so it must never read as reassuring
 * when it is simply not known.
 */
import type { RoleResponse } from "@datacanvas/shared-types";

export interface ServerAddress {
  /** What to show for the address. */
  text: string;
  /** The address was read (an address, or a genuine "none": a local socket). */
  known: boolean;
}

export function serverAddressText(role: RoleResponse | null, failed: boolean): ServerAddress {
  if (role === null) {
    return failed
      ? { text: "could not be read", known: false }
      : { text: "not known yet", known: false };
  }
  const address = role.role.serverAddress;
  return address === null
    ? { text: "none (a local socket)", known: true }
    : { text: address, known: true };
}

/** Said when the address is not known: the dialog stays usable, but the missing check is visible. */
export const ADDRESS_UNKNOWN_WARNING =
  "The address the database server reports is not available, so DataCanvas cannot show where this connection really goes. A tunnel or proxy on this machine can lead to a remote or production database. Check that before you continue.";
