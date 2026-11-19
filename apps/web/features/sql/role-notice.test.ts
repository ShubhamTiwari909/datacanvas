import { describe, expect, it } from "vitest";
import { sqlRoleNotice } from "./role-notice";

const role = (over: Partial<Parameters<typeof sqlRoleNotice>[0]> = {}) => ({
  roleName: "alice",
  superuser: false,
  powerfulRoles: [],
  ...over,
});

describe("sqlRoleNotice", () => {
  it("says nothing for an ordinary role, or for one with other powers", () => {
    expect(sqlRoleNotice(role())).toBeNull();
    expect(
      sqlRoleNotice(role({ powerfulRoles: ["pg_write_all_data", "pg_read_all_data"] })),
    ).toBeNull();
  });

  it("warns about a superuser, by name", () => {
    const notice = sqlRoleNotice(role({ superuser: true }))!;
    expect(notice).toContain("alice is a superuser");
    expect(notice).toContain("read-only role");
  });

  it("warns about each right over the database server's files and programs", () => {
    expect(sqlRoleNotice(role({ powerfulRoles: ["pg_execute_server_program"] }))).toContain(
      "alice can run programs on the database server",
    );
    expect(
      sqlRoleNotice(role({ powerfulRoles: ["pg_read_server_files", "pg_write_server_files"] })),
    ).toContain("read files on the database server and write files on the database server");
  });
});
