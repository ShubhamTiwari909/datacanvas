/**
 * What the SQL view says about the connected role. A read-only transaction stops every write,
 * but not what a function can do outside the database: a superuser, or a role that may run
 * programs or read files on the database server, can do that from a SELECT (threat model,
 * section 8). So the view says so, above the editor, for such a role. Information, never a block.
 */
import type { RoleInfo } from "@datacanvas/database-core";

const SERVER_RIGHTS = [
  "pg_execute_server_program",
  "pg_read_server_files",
  "pg_write_server_files",
];

export function sqlRoleNotice(
  role: Pick<RoleInfo, "roleName" | "superuser" | "powerfulRoles">,
): string | null {
  const rights = role.powerfulRoles.filter((r) => SERVER_RIGHTS.includes(r));
  if (!role.superuser && rights.length === 0) return null;
  const why = role.superuser
    ? `${role.roleName} is a superuser`
    : `${role.roleName} can ${rights.map(describe).join(" and ")}`;
  return `${why}. A read-only transaction stops every write in the database, but not what a function can do outside it: reach the database server's files or programs, or write through another connection (an extension such as dblink). Use a read-only role for SQL you did not write yourself.`;
}

function describe(right: string): string {
  if (right === "pg_execute_server_program") return "run programs on the database server";
  if (right === "pg_read_server_files") return "read files on the database server";
  return "write files on the database server";
}
