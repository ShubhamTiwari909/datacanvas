/**
 * The contract every database provider implements.
 *
 * The rest of DataCanvas (route handlers, services, UI) talks ONLY to this
 * interface and never to a driver. That is what lets us:
 *   - test everything with an in-memory mock (see `testing/`),
 *   - keep SQL and driver details inside one package per provider,
 *   - add another database later without touching the web app.
 *
 * Every method that fails throws a `DatabaseError` (see errors.ts), never a
 * raw driver error.
 *
 * One adapter instance is bound to ONE database (the connection details are
 * given to the adapter's constructor, not to its methods).
 *
 * All methods are READ-ONLY (writes are a separate interface,
 * `WritableAdapter`, below). Almost all return STRUCTURE (names, types, keys,
 * definitions, counters). `getRows` is the one method that returns table ROWS: it
 * exists for the opt-in data viewer, and it is the caller's job (the service
 * layer) to call it only when the person has switched data viewing on for that
 * connection. There is deliberately no method on THIS interface that runs arbitrary SQL: running a statement the person typed is a separate, read-only capability (`SqlRunnerAdapter`, `sql-run.ts`), as changing data is (`WritableAdapter`).
 */
import type { DdlDetail } from "./ddl.js";
import type { AppliedChange, Change, PlannedChange, RoleInfo, TableEditInfo } from "./changes.js";
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  IndexInfo,
  IndexUsageReport,
  RelationshipInfo,
  RowPage,
  RowsOptions,
  CellRequest,
  CellRead,
  SchemaInfo,
  SearchHit,
  TableDetailsEntry,
  TableInfo,
  TableRef,
} from "./models.js";

export interface DatabaseAdapter {
  /**
   * Open the connection (or connection pool) and verify it works.
   * Calling it again while connected does nothing.
   *
   * @throws DatabaseError `unreachable`, `authentication_failed`, `ssl_error`,
   *   `timeout`, `database_not_found`, ...
   */
  connect(): Promise<void>;

  /**
   * Check that the connection details work, WITHOUT keeping anything open.
   * Used by the "Test connection" button. It works whether or not `connect()`
   * was called, and does not change the adapter's connected state.
   *
   * @throws DatabaseError, same codes as `connect()`.
   */
  testConnection(): Promise<void>;

  /** All user-visible schemas (system schemas such as pg_catalog are excluded). */
  getSchemas(): Promise<SchemaInfo[]>;

  /**
   * Tables, views and materialized views in a schema, sorted by name.
   * @throws DatabaseError `not_found` if the schema does not exist.
   */
  getTables(schema: string): Promise<TableInfo[]>;

  /**
   * Columns of a table or view, in definition order.
   * @throws DatabaseError `not_found` if the table does not exist.
   */
  getColumns(schema: string, table: string): Promise<ColumnInfo[]>;

  /**
   * Constraints of a table (primary key, foreign keys, unique, check).
   * Views have none, so the result is empty for them.
   * @throws DatabaseError `not_found` if the table does not exist.
   */
  getConstraints(schema: string, table: string): Promise<ConstraintInfo[]>;

  /**
   * Indexes of a table or materialized view.
   * @throws DatabaseError `not_found` if the table does not exist.
   */
  getIndexes(schema: string, table: string): Promise<IndexInfo[]>;

  /**
   * Description, columns, constraints and indexes of MANY tables in one call.
   *
   * Equivalent to calling `getTables`, `getColumns`, `getConstraints` and
   * `getIndexes` for each table, but a good implementation needs a fixed number
   * of queries however many tables are asked for. The canvas relies on this: a
   * hundred tables must not mean hundreds of round trips to a remote database.
   *
   * - Results follow the order of `tables`; a table listed twice appears once.
   * - An empty list returns an empty array.
   * - All or nothing: if any table does not exist the whole call fails.
   *
   * @throws DatabaseError `not_found` if any listed table does not exist.
   */
  getTablesDetails(tables: TableRef[]): Promise<TableDetailsEntry[]>;

  /**
   * Find tables, views and columns whose NAME contains `query`, anywhere in the
   * database (every user schema). Used by the canvas search box, which must find
   * things that are not on the canvas yet.
   *
   * - Case-insensitive substring match. Characters such as `%` and `_` are
   *   ordinary characters, never wildcards.
   * - Results are ranked: an exact name first, then names that start with the
   *   query, then the rest, then by schema and name.
   * - At most `limit` table hits AND at most `limit` column hits are returned
   *   (tables first), so a short query on a huge database stays cheap.
   * - A blank query returns an empty array. Only names are searched, never data.
   */
  searchObjects(query: string, limit: number): Promise<SearchHit[]>;

  /**
   * The parts of a definition that a migration must say and the structure does not record
   * (`ddl.ts`): identity, generated and collation of columns, deferrable and not-yet-validated
   * constraints, partitioning, inheritance, unlogged and storage options of tables, and the
   * comments on schemas, types, sequences, indexes and constraints. Sparse: only what is not the
   * default. Names and settings only.
   *
   * `tables` are the relations to read (as for `getTablesDetails`); `schemas` are the schemas
   * whose own comments are wanted. Empty lists read nothing but the server's version.
   */
  getDdlDetail(tables: readonly TableRef[], schemas: readonly string[]): Promise<DdlDetail>;

  /**
   * Every confirmed foreign-key relationship in the database, across schemas.
   * One call for the whole database, because drawing the canvas needs all
   * the edges at once.
   */
  getRelationships(): Promise<RelationshipInfo[]>;

  /**
   * Views (with their definitions and what they read), user-defined types,
   * sequences, functions and procedures, triggers, extensions and row-level
   * security policies, for the whole database, in one call. All of it is
   * definition text and settings from the catalogs: no table rows and no
   * sequence values are read.
   *
   * - Objects that belong to an extension (its functions and types) are left
   *   out; the extension itself is listed.
   * - Definition text longer than `MAX_OBJECT_TEXT` is cut.
   * - Every list is sorted (schema, then name), so the result is stable.
   */
  getObjects(): Promise<DatabaseObjects>;

  /**
   * How often each index of the ordinary tables has been used, from the
   * server's statistics counters, plus when they were last reset and whether
   * this server is a standby. Counters only: no table rows are read.
   *
   * - Indexes of partitions are left out (the partitioned table is the unit, as
   *   everywhere else).
   * - The counters are the server's own and may be young or reset; see
   *   `IndexUsageReport` for what they can and cannot say.
   */
  getIndexUsage(): Promise<IndexUsageReport>;

  /**
   * One page of the ROWS of a table, view or materialized view, read-only and
   * bounded. This is the only method that returns table data.
   *
   * - Every value is read as text, and cut in the database to `ROWS_CELL_CHARS`
   *   (flagged `truncated`); SQL NULL stays distinct from the empty string.
   * - Columns whose names look sensitive (`isSensitiveColumnName`) are NOT read
   *   unless listed in `options.revealColumns`; their cells come back empty and
   *   the column says `masked`.
   * - At most `ROWS_MAX_COLUMNS` columns are read (the page says how many were
   *   left out), at most `options.pageSize` rows, and about
   *   `ROWS_MAX_RESPONSE_CHARS` characters in all (`cutBySize`).
   * - Ordered by the primary key, or else a unique index on NOT NULL columns,
   *   and paged by that key (`nextCursor`), so a deep page is as fast as the
   *   first. A table with no such key is read in no particular order, by
   *   position, and only down to `ROWS_MAX_OFFSET` rows (`offsetCapped`).
   * - No row count is computed. The cursor is opaque and untrusted.
   * - An empty table, or one with no columns, gives an empty page.
   *
   * @throws DatabaseError `invalid_request` for a page size or cursor that is not
   *   valid for this table, `not_found` if the table does not exist,
   *   `not_supported` for a foreign table, `permission_denied` without SELECT.
   *   The error text never contains a value from the table.
   */
  getRows(table: TableRef, options: RowsOptions): Promise<RowPage>;

  /**
   * ONE `json` or `jsonb` value of ONE row, read whole up to `CELL_EDIT_MAX_CHARS`, for the JSON editor
   * (a page of rows cuts every cell at `ROWS_CELL_CHARS`). Like `getRows` it returns table data, and the
   * service calls it only behind the same data-access check.
   *
   * - The row is found by the table's row key (the primary key, else a usable unique index); every key
   *   column is named once, and every value is a bound parameter. A table without a key has no cell to name.
   * - Any other column type, or a column that does not exist, is `invalid_request`; a column whose name
   *   looks sensitive and was not revealed is `invalid_request` too (it would be an oracle).
   * - A value over the limit is not sent: `tooLarge` is true and `value` is null.
   *
   * @throws DatabaseError `not_found` (no such table or no such row), `not_supported` (a foreign table),
   *   `invalid_request`, `permission_denied`. The error text never contains a value from the table.
   */
  getCell(table: TableRef, request: CellRequest): Promise<CellRead>;

  /**
   * What the connected role can do (superuser, role and database creation,
   * row-level security, predefined write and server-file roles, CREATE rights,
   * how many tables it can write to) and the address the server reports.
   * Catalog only, read-only, no rows.
   */
  getRoleInfo(): Promise<RoleInfo>;

  /**
   * Close everything and release resources. Safe to call more than once, and
   * safe to call when never connected. After it, data methods throw
   * `not_connected` until `connect()` is called again.
   */
  disconnect(): Promise<void>;
}

/**
 * The WRITE capability (1.4.0, `docs/data-editing-plan.md`). Kept apart from
 * `DatabaseAdapter`, which stays read-only: only the PostgreSQL adapter and the
 * mock implement it, and only the server's write service may use it, after the
 * start-up flag, the local-database rule and the per-connection unlock have all
 * passed. A rule in `tests/architecture.test.ts` fails if any other app file
 * imports it.
 *
 * There is no method that takes SQL. A change is a structured `Change`; the
 * adapter checks every name against the catalog, builds the statement itself,
 * and binds every value as a parameter.
 */
export interface WritableAdapter {
  /**
   * What the row editor needs about one table: whether its rows can be edited
   * and by which key, its columns with their types and whether the database
   * fills them, its triggers, row-level security and incoming foreign keys.
   * Read-only, catalog only.
   *
   * @throws DatabaseError `not_found`.
   */
  describeForEdit(table: TableRef): Promise<TableEditInfo>;

  /**
   * Check a change against the catalog and build the exact statements, the
   * effect and the warnings, in a READ-ONLY transaction. Nothing is changed.
   *
   * @throws DatabaseError `invalid_change`, `not_editable`, `not_found`,
   *   `already_exists`, `has_dependents`, `invalid_value`. Messages name
   *   structure only, never a value.
   */
  previewChange(change: Change): Promise<PlannedChange>;

  /**
   * Run a planned change EXACTLY as planned, in one read-write transaction with
   * a short lock timeout and a statement timeout. A row change must affect
   * exactly one row, or everything rolls back (`row_changed` for none).
   *
   * @throws DatabaseError `row_changed`, `unique_violation`,
   *   `foreign_key_violation`, `not_null_violation`, `check_violation`,
   *   `invalid_value`, `locked`, `retry`, `write_denied`, `has_dependents`,
   *   `already_exists`, `timeout`. Never the database's own message.
   */
  applyChange(plan: PlannedChange): Promise<AppliedChange>;
}

/** Does this adapter also implement the write capability? */
export function isWritableAdapter<T extends object>(adapter: T): adapter is T & WritableAdapter {
  return (
    typeof (adapter as Partial<WritableAdapter>).applyChange === "function" &&
    typeof (adapter as Partial<WritableAdapter>).previewChange === "function" &&
    typeof (adapter as Partial<WritableAdapter>).describeForEdit === "function"
  );
}
