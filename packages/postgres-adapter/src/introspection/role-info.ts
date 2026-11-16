/**
 * What the connected role can do (decision 126), read from the catalog in one
 * query. No table row is read: `has_table_privilege` and `has_schema_privilege`
 * look at the access lists, not at the data.
 *
 * - The predefined roles that can write anywhere (`pg_write_all_data`, from
 *   PostgreSQL 14) or reach the server's files and programs are listed only
 *   when they exist on this server, so the query works on 12 to 18.
 * - The count of writable tables is capped, so a database with a million
 *   tables still answers quickly.
 * - `inet_server_addr()` is the address the server itself reports (null over a
 *   Unix socket), shown in the unlock dialog next to the database name.
 */
import type { RoleInfo } from "@datacanvas/database-core";
import { excludeSystemSchemas } from "./system-schemas.js";
import type { Queryable } from "./types.js";

/** The most writable tables counted. */
export const ROLE_TABLE_COUNT_CAP = 10_000;

const POWERFUL_ROLES = [
  "pg_write_all_data",
  "pg_execute_server_program",
  "pg_write_server_files",
  "pg_read_server_files",
];

const ROLE_INFO_SQL = `
  SELECT
    r.rolname::text AS role_name,
    r.rolsuper AS superuser,
    r.rolcreaterole AS create_role,
    r.rolcreatedb AS create_db,
    r.rolbypassrls AS bypass_rls,
    ARRAY(
      SELECT p.rolname::text
      FROM pg_catalog.pg_roles p
      WHERE p.rolname = ANY ($1::text[])
        AND pg_catalog.pg_has_role(r.oid, p.oid, 'MEMBER')
      ORDER BY 1
    ) AS powerful_roles,
    pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') AS can_create,
    (
      SELECT count(*)
      FROM pg_catalog.pg_namespace n
      WHERE ${excludeSystemSchemas("n.nspname")}
        AND pg_catalog.has_schema_privilege(n.oid, 'CREATE')
    )::int AS schemas_with_create,
    (
      SELECT count(*) FROM (
        SELECT 1
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND ${excludeSystemSchemas("n.nspname")}
          AND pg_catalog.has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
        LIMIT $2
      ) writable
    )::int AS writable_tables,
    pg_catalog.host(pg_catalog.inet_server_addr()) AS server_address
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user
`;

interface RoleRow {
  role_name: string;
  superuser: boolean;
  create_role: boolean;
  create_db: boolean;
  bypass_rls: boolean;
  powerful_roles: string[];
  can_create: boolean;
  schemas_with_create: number;
  writable_tables: number;
  server_address: string | null;
}

export async function readRoleInfo(db: Queryable): Promise<RoleInfo> {
  const { rows } = await db.query<RoleRow>(ROLE_INFO_SQL, [POWERFUL_ROLES, ROLE_TABLE_COUNT_CAP]);
  const row = rows[0];
  if (!row) {
    // current_user always has a pg_roles row; reaching this means the catalog is not readable.
    throw new Error("the connected role was not found in pg_roles");
  }
  return {
    roleName: row.role_name,
    superuser: row.superuser,
    createRole: row.create_role,
    createDb: row.create_db,
    bypassRls: row.bypass_rls,
    powerfulRoles: row.powerful_roles,
    canCreateInDatabase: row.can_create,
    schemasWithCreate: row.schemas_with_create,
    writableTables: row.writable_tables,
    serverAddress: row.server_address,
  };
}
