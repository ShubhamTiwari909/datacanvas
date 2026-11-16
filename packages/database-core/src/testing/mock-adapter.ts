/**
 * An in-memory `DatabaseAdapter` backed by plain data. It exists for:
 *   - unit tests of services and route handlers (no real database needed),
 *   - building and demoing the UI before a database is available,
 *   - proving that the interface can be implemented without any driver.
 *
 * It follows the same rules as a real adapter: methods throw `not_connected`
 * before `connect()`, unknown schemas and tables throw `not_found`, and
 * failures are `DatabaseError`s.
 */
import type { DatabaseAdapter } from "../adapter.js";
import { DatabaseError, type DatabaseErrorCode } from "../errors.js";
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  IndexInfo,
  IndexUsageReport,
  RelationshipInfo,
  RowColumn,
  RowOrder,
  RowPage,
  RowsOptions,
  SchemaInfo,
  SearchHit,
  TableDetailsEntry,
  TableInfo,
  TableRef,
} from "../models.js";
import { normalizeObjects } from "../objects.js";
import { buildRowPage, isSensitiveColumnName, normalizeRowsOptions, type RawRow } from "../rows.js";
import { ROWS_MAX_COLUMNS, ROWS_MAX_OFFSET } from "../models.js";
import { uniqueTableRefs } from "../table-refs.js";
import { createEcommerceData, type MockDatabaseData } from "./ecommerce-fixture.js";

export interface MockAdapterOptions {
  /** Data to serve. Defaults to the sample shop database. */
  data?: MockDatabaseData;
  /** Make `connect()` and `testConnection()` fail with this error, to test error handling. */
  failConnectWith?: DatabaseErrorCode;
}

/**
 * Copy data so callers cannot change the mock's internal state. Going through
 * JSON works precisely because the models are JSON-safe by design.
 */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MockDatabaseAdapter implements DatabaseAdapter {
  private connected = false;
  private readonly data: MockDatabaseData;
  private readonly failConnectWith: DatabaseErrorCode | undefined;

  constructor(options: MockAdapterOptions = {}) {
    this.data = options.data ?? createEcommerceData();
    this.failConnectWith = options.failConnectWith;
  }

  // All public methods are `async` on purpose: a thrown DatabaseError then
  // becomes a REJECTED PROMISE, exactly like a real adapter. A plain method
  // that throws would raise synchronously, so `await call()` inside a
  // try/catch would behave differently for the mock than for production.
  async connect(): Promise<void> {
    this.throwIfConfiguredToFail();
    this.connected = true;
  }

  async testConnection(): Promise<void> {
    // Does not touch `connected`: testing must leave the adapter's state alone.
    this.throwIfConfiguredToFail();
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    this.requireConnection();
    return copy(this.data.schemas);
  }

  async getTables(schema: string): Promise<TableInfo[]> {
    this.requireConnection();
    this.requireSchema(schema);
    return copy(this.data.tables.filter((t) => t.schema === schema));
  }

  async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    return copy(this.lookup(this.data.columns, schema, table));
  }

  async getConstraints(schema: string, table: string): Promise<ConstraintInfo[]> {
    return copy(this.lookup(this.data.constraints, schema, table));
  }

  async getIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    return copy(this.lookup(this.data.indexes, schema, table));
  }

  async getTablesDetails(tables: TableRef[]): Promise<TableDetailsEntry[]> {
    this.requireConnection();
    // Resolve every table first, so the call is all-or-nothing like the real adapter.
    return uniqueTableRefs(tables).map((ref) => {
      const table = this.data.tables.find((t) => t.schema === ref.schema && t.name === ref.name);
      if (!table) throw new DatabaseError("not_found");
      return copy({
        table,
        columns: this.lookup(this.data.columns, ref.schema, ref.name),
        constraints: this.lookup(this.data.constraints, ref.schema, ref.name),
        indexes: this.lookup(this.data.indexes, ref.schema, ref.name),
      });
    });
  }

  async searchObjects(query: string, limit: number): Promise<SearchHit[]> {
    this.requireConnection();
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];

    // Lower is better: exact name, then prefix, then anywhere.
    const rank = (name: string): number => {
      const lower = name.toLowerCase();
      return lower === needle ? 0 : lower.startsWith(needle) ? 1 : 2;
    };
    const matches = (name: string): boolean => name.toLowerCase().includes(needle);
    const byRank = <T extends { name: string; schema: string; table: string }>(
      a: T,
      b: T,
    ): number =>
      rank(a.name) - rank(b.name) ||
      a.schema.localeCompare(b.schema) ||
      a.table.localeCompare(b.table) ||
      a.name.localeCompare(b.name);

    const tables = this.data.tables
      .filter((t) => matches(t.name))
      .map((t) => ({ name: t.name, schema: t.schema, table: t.name, kind: t.kind }))
      .sort(byRank)
      .slice(0, limit)
      .map((t): SearchHit => ({
        kind: t.kind,
        schema: t.schema,
        table: t.table,
        column: null,
        dataType: null,
      }));

    const columns = Object.entries(this.data.columns)
      .flatMap(([key, list]) => {
        const [schema = "", table = ""] = key.split(".");
        return list
          .filter((c) => matches(c.name))
          .map((c) => ({ name: c.name, schema, table, dataType: c.dataType }));
      })
      .sort(byRank)
      .slice(0, limit)
      .map((c): SearchHit => ({
        kind: "column",
        schema: c.schema,
        table: c.table,
        column: c.name,
        dataType: c.dataType,
      }));

    return copy([...tables, ...columns]);
  }

  async getRelationships(): Promise<RelationshipInfo[]> {
    this.requireConnection();
    return copy(this.data.relationships);
  }

  async getObjects(): Promise<DatabaseObjects> {
    this.requireConnection();
    return normalizeObjects(copy(this.data.objects));
  }

  async getRows(ref: TableRef, options: RowsOptions): Promise<RowPage> {
    this.requireConnection();
    const { pageSize, cursor, reveal } = normalizeRowsOptions(options);
    const table = this.data.tables.find((t) => t.schema === ref.schema && t.name === ref.name);
    if (!table) throw new DatabaseError("not_found");
    if (table.kind === "foreign_table") throw new DatabaseError("not_supported");

    const all = this.lookup(this.data.columns, ref.schema, ref.name);
    const shown = all.slice(0, ROWS_MAX_COLUMNS);
    const columns: RowColumn[] = shown.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      masked: isSensitiveColumnName(c.name) && !reveal.has(c.name),
    }));
    const empty = (order: RowOrder): RowPage =>
      buildRowPage({
        columns,
        hiddenColumns: all.length - shown.length,
        order,
        rawRows: [],
        pageSize,
        offset: 0,
      });

    const mapKey = `${ref.schema}.${ref.name}`;
    const key = this.rowKey(mapKey);
    const order: RowOrder = key
      ? { kind: key.kind, columns: key.columns }
      : { kind: "none", columns: [] };
    if (all.length === 0) return empty(order);

    const stored = Object.hasOwn(this.data.rows, mapKey) ? this.data.rows[mapKey]! : [];
    let rows = stored;
    let start = 0;
    let offset = 0;
    let limit = pageSize;
    if (key) {
      const byKey = (a: Record<string, string | null>, b: Record<string, string | null>): number =>
        this.compareKeys(
          mapKey,
          key.columns.map((c) => a[c] ?? ""),
          key.columns.map((c) => b[c] ?? ""),
          key.columns,
        );
      rows = [...stored].sort(byKey);
      if (cursor) {
        if (cursor.kind !== "keyset" || cursor.values.length !== key.columns.length) {
          throw new DatabaseError("invalid_request");
        }
        const after = cursor.values;
        start = rows.findIndex(
          (r) =>
            this.compareKeys(
              mapKey,
              key.columns.map((c) => r[c] ?? ""),
              after,
              key.columns,
            ) > 0,
        );
        if (start === -1) start = rows.length;
      }
    } else if (cursor) {
      if (cursor.kind !== "offset") throw new DatabaseError("invalid_request");
      offset = cursor.offset;
      start = offset;
      // Same depth limit as the real adapter: nothing is readable past it.
      limit = Math.max(0, Math.min(pageSize, ROWS_MAX_OFFSET - offset));
    } else {
      limit = Math.min(pageSize, ROWS_MAX_OFFSET);
    }

    const rawRows: RawRow[] = rows.slice(start, start + limit + 1).map((row) => ({
      cells: shown.map((c) => row[c.name] ?? null),
      key: key ? key.columns.map((c) => row[c] ?? "") : null,
    }));
    return buildRowPage({
      columns,
      hiddenColumns: all.length - shown.length,
      order,
      rawRows,
      pageSize: limit,
      offset,
    });
  }

  /** The columns a table is read and paged by: its primary key, else a unique index on NOT NULL columns. */
  private rowKey(
    mapKey: string,
  ): { kind: "primary_key" | "unique_index"; columns: string[] } | null {
    const primary = (this.data.constraints[mapKey] ?? []).find((c) => c.kind === "primary_key");
    if (primary) return { kind: "primary_key", columns: [...primary.columns] };
    const columns = this.data.columns[mapKey] ?? [];
    const unique = (this.data.indexes[mapKey] ?? []).find(
      (i) =>
        i.unique &&
        !/\sWHERE\s/i.test(i.definition ?? "") &&
        i.columns.every((name) => columns.find((c) => c.name === name)?.nullable === false),
    );
    return unique ? { kind: "unique_index", columns: [...unique.columns] } : null;
  }

  /** Compare two keys the way the database would: numbers as numbers, everything else as text. */
  private compareKeys(mapKey: string, a: string[], b: string[], names: string[]): number {
    const columns = this.data.columns[mapKey] ?? [];
    for (let i = 0; i < names.length; i += 1) {
      const type = columns.find((c) => c.name === names[i])?.dataType ?? "text";
      const numeric = /^(smallint|integer|bigint|numeric|real|double precision)/.test(type);
      const x = a[i] ?? "";
      const y = b[i] ?? "";
      const result = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
      if (result !== 0) return result < 0 ? -1 : 1;
    }
    return 0;
  }

  async getIndexUsage(): Promise<IndexUsageReport> {
    this.requireConnection();
    return copy(this.data.indexUsage);
  }

  async disconnect(): Promise<void> {
    this.connected = false; // idempotent: fine when already disconnected
  }

  private throwIfConfiguredToFail(): void {
    if (this.failConnectWith) throw new DatabaseError(this.failConnectWith);
  }

  private requireConnection(): void {
    if (!this.connected) throw new DatabaseError("not_connected");
  }

  private requireSchema(schema: string): void {
    if (!this.data.schemas.some((s) => s.name === schema)) throw new DatabaseError("not_found");
  }

  /** Look up per-table data, enforcing the connected and exists rules shared by the table-level methods. */
  private lookup<T>(source: Record<string, T[]>, schema: string, table: string): T[] {
    this.requireConnection();
    const key = `${schema}.${table}`;
    // Object.hasOwn: a table called "constructor" must not match an inherited property.
    const rows = Object.hasOwn(source, key) ? source[key] : undefined;
    if (rows === undefined) throw new DatabaseError("not_found");
    return rows;
  }
}
