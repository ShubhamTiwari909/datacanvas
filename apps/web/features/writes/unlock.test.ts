import type { RoleResponse } from "@datacanvas/shared-types";
import { describe, expect, it } from "vitest";
import { ADDRESS_UNKNOWN_WARNING, serverAddressText } from "./unlock";

const role = (serverAddress: string | null): RoleResponse => ({
  role: {
    roleName: "shop_owner",
    superuser: false,
    createRole: false,
    createDb: false,
    bypassRls: false,
    powerfulRoles: [],
    canCreateInDatabase: false,
    schemasWithCreate: 0,
    writableTables: 0,
    serverAddress,
  },
  warnings: { read: [], write: [] },
});

describe("the address the unlock dialog shows", () => {
  it("never reads as a local socket while the role is loading or could not be read", () => {
    expect(serverAddressText(null, false)).toEqual({ text: "not known yet", known: false });
    expect(serverAddressText(null, true)).toEqual({ text: "could not be read", known: false });
    for (const failed of [false, true])
      expect(serverAddressText(null, failed).text).not.toMatch(/socket/);
  });

  it("shows the address the server reported", () => {
    expect(serverAddressText(role("10.0.0.5"), false)).toEqual({ text: "10.0.0.5", known: true });
  });

  it("calls a genuine 'no address' a local socket", () => {
    expect(serverAddressText(role(null), false)).toEqual({
      text: "none (a local socket)",
      known: true,
    });
  });

  it("warns plainly about a tunnel when the address is missing", () => {
    expect(ADDRESS_UNKNOWN_WARNING).toMatch(/tunnel or proxy/);
    expect(ADDRESS_UNKNOWN_WARNING).toMatch(/production/);
  });
});
