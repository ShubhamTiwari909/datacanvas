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
  IndexInfo,
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
   * Close everything and release resources. Safe to call more than once, and
   * safe to call when never connected. After it, data methods throw
   * `not_connected` until `connect()` is called again.
   */
  disconnect(): Promise<void>;
}
