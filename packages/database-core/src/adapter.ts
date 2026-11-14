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
 * All methods are READ-ONLY and return STRUCTURE only. There is deliberately
 * no method that runs arbitrary SQL or returns table rows.
 */
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  IndexInfo,
  IndexUsageReport,
  RelationshipInfo,
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
   * Close everything and release resources. Safe to call more than once, and
   * safe to call when never connected. After it, data methods throw
   * `not_connected` until `connect()` is called again.
   */
  disconnect(): Promise<void>;
}
