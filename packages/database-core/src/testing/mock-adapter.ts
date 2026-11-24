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
import type { DatabaseAdapter, WritableAdapter } from "../adapter.js";
import type {
  AppliedChange,
  Change,
  CancelSignal,
  PlannedChange,
  RoleInfo,
  StructureChange,
  TableEditInfo,
} from "../changes.js";
import { emptyDdl, type DdlDetail } from "../ddl.js";
import { DatabaseError, type DatabaseErrorCode } from "../errors.js";
import type {
  CellRead,
  CellRequest,
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  IndexInfo,
  IndexUsageReport,
  RelationshipInfo,
  RowColumn,
  RowOrder,
  RowPage,
  RowSecurityState,
  RowsOptions,
  SchemaInfo,
  SearchHit,
  TableDetailsEntry,
  TableInfo,
  TableRef,
  TableStatistics,
  DatabaseSizes,
} from "../models.js";
import { normalizeObjects } from "../objects.js";
import type { ExportEvent, ExportRowsOptions, ExportSignal } from "../rows-export.js";
import {
  PREFLIGHT_MAX_CHECKS,
  type PreflightCheck,
  type PreflightResult,
} from "../migration/preflight.js";
import type { ValidateRequest, ValidationReport } from "../validation.js";
import {
  checkStatementText,
  SqlStatementError,
  type SqlRunRequest,
  type SqlRunResult,
  type SqlRunnerAdapter,
} from "../sql-run.js";
import {
  buildRowPage,
  checkRowsFilters,
  checkRowsSort,
  isSensitiveColumnName,
  normalizeRowsOptions,
  type RawRow,
} from "../rows.js";
import {
  ROWS_MAX_COLUMNS,
  ROWS_MAX_OFFSET,
  ROWS_MAX_SORT_VALUE_CHARS,
  type RowColumnKind,
  type RowFilter,
  type RowSort,
} from "../models.js";
import { uniqueTableRefs } from "../table-refs.js";
import { createEcommerceData, type MockDatabaseData } from "./ecommerce-fixture.js";
import { MockWrites } from "./mock-writes.js";

/** What the mock treats a column as, from the type name the sample data uses (the real adapter asks the catalog). */
function kindOf(dataType: string): RowColumnKind {
  if (/\[\]$/.test(dataType) || /^(json|jsonb|bytea|xml|point|tsvector)\b/.test(dataType)) {
    return "other";
  }
  if (/^(text|character|varchar|char|name|citext)\b/.test(dataType)) return "text";
  return "ordered";
}

/** Is this one of the number types the sample data uses? */
function isNumericType(type: string): boolean {
  return /^(smallint|integer|bigint|numeric|real|double precision)/.test(type);
}

/** The sort value as the adapter reads it: cut one character past what a cursor can carry. */
function cutSortValue(value: string | null): string | null {
  return value === null ? null : value.slice(0, ROWS_MAX_SORT_VALUE_CHARS + 1);
}

/** The sample role: an ordinary owner of a local development database. */
export const MOCK_ROLE: RoleInfo = {
  roleName: "shop_owner",
  superuser: false,
  createRole: false,
  createDb: false,
  bypassRls: false,
  powerfulRoles: [],
  canCreateInDatabase: true,
  schemasWithCreate: 1,
  writableTables: 4,
  serverAddress: "127.0.0.1",
};

export interface MockAdapterOptions {
  /** What `getRoleInfo()` answers. Defaults to `MOCK_ROLE`. */
  role?: RoleInfo;
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

export class MockDatabaseAdapter implements DatabaseAdapter, WritableAdapter, SqlRunnerAdapter {
  private connected = false;
  private readonly data: MockDatabaseData;
  private readonly failConnectWith: DatabaseErrorCode | undefined;
  private readonly role: RoleInfo;
  private readonly writes: MockWrites;

  constructor(options: MockAdapterOptions = {}) {
    // A fixture passed in is copied: writes must not leak into it, or into another adapter using it.
    this.data = options.data ? copy(options.data) : createEcommerceData();
    this.writes = new MockWrites(this.data);
    this.role = options.role ?? MOCK_ROLE;
    this.failConnectWith = options.failConnectWith;
  }

  /** What `runStatement` answers; tests replace it. By default one row, "ok". */
  sqlHandler: (request: SqlRunRequest) => Promise<SqlRunResult> = async () => ({
    columns: [{ name: "result", dataType: "text" }],
    rows: [["ok"]],
    truncated: false,
    command: "SELECT",
    cutCells: 0,
    elapsedMs: 1,
  });

  /** The SQL runner: the same first-word check as the real adapter, then `sqlHandler`. */
  async runStatement(request: SqlRunRequest): Promise<SqlRunResult> {
    if (!this.connected) throw new DatabaseError("not_connected");
    const check = checkStatementText(request.text);
    if (!check.ok) throw new SqlStatementError("not_allowed", check.message);
    return this.sqlHandler(request);
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

  /** The mock has no definitions to speak of: nothing special, on a recent server. */
  async getDdlDetail(
    _tables?: readonly TableRef[],
    _schemas?: readonly string[],
  ): Promise<DdlDetail> {
    this.requireConnection();
    return emptyDdl(160000);
  }

  async getObjects(): Promise<DatabaseObjects> {
    this.requireConnection();
    return normalizeObjects(copy(this.data.objects));
  }

  /** The sample data has no `json` column to read whole: a table that exists is `invalid_request`, one that does not is `not_found`. */
  async getCell(ref: TableRef, request: CellRequest): Promise<CellRead> {
    this.requireConnection();
    const table = this.data.tables.find((t) => t.schema === ref.schema && t.name === ref.name);
    if (!table) throw new DatabaseError("not_found");
    if (table.kind === "foreign_table") throw new DatabaseError("not_supported");
    void request;
    throw new DatabaseError("invalid_request");
  }

  /** The mock has no rows to write to a file. */
  async exportRows(
    ref: TableRef,
    options: ExportRowsOptions,
    sink: (event: ExportEvent) => void | boolean | Promise<void | boolean>,
    signal?: ExportSignal,
  ): Promise<void> {
    void signal;
    this.requireConnection();
    void ref;
    void options;
    void sink;
    throw new DatabaseError("not_supported");
  }

  /** The mock has no rows to check a migration against: every check answers "missing". The cap is the real one. */
  async preflight(checks: PreflightCheck[]): Promise<PreflightResult[]> {
    this.requireConnection();
    if (checks.length > PREFLIGHT_MAX_CHECKS) throw new DatabaseError("invalid_request");
    return checks.map(() => ({ status: "missing" as const, count: 0 }));
  }

  /** The mock has no database to check values against. */
  async validateRows(request: ValidateRequest): Promise<ValidationReport> {
    this.requireConnection();
    void request;
    throw new DatabaseError("not_supported");
  }

  async getRows(ref: TableRef, options: RowsOptions): Promise<RowPage> {
    this.requireConnection();
    const {
      pageSize,
      cursor,
      reveal,
      sort: requestedSort,
      filters: requestedFilters,
    } = normalizeRowsOptions(options);
    const table = this.data.tables.find((t) => t.schema === ref.schema && t.name === ref.name);
    if (!table) throw new DatabaseError("not_found");
    if (table.kind === "foreign_table") throw new DatabaseError("not_supported");

    const all = this.lookup(this.data.columns, ref.schema, ref.name);
    const shown = all.slice(0, ROWS_MAX_COLUMNS);
    const columns: RowColumn[] = shown.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      masked: isSensitiveColumnName(c.name) && !reveal.has(c.name),
      kind: kindOf(c.dataType),
    }));
    // The sample role is not the owner of anything, so security that is on applies to it.
    const rowSecurity: RowSecurityState = this.data.objects.rowSecurity.some(
      (r) => r.schema === ref.schema && r.table === ref.name,
    )
      ? "applies"
      : "off";
    const empty = (order: RowOrder, sort: RowSort | null, filters: RowFilter[]): RowPage =>
      buildRowPage({
        columns,
        hiddenColumns: all.length - shown.length,
        order,
        rawRows: [],
        pageSize,
        offset: 0,
        rowSecurity,
        sort,
        filters,
      });

    const mapKey = `${ref.schema}.${ref.name}`;
    const key = this.rowKey(mapKey);
    const order: RowOrder = key
      ? { kind: key.kind, columns: key.columns }
      : { kind: "none", columns: [] };
    const sort = checkRowsSort(requestedSort, columns, order);
    const filters = checkRowsFilters(requestedFilters, columns);
    // PostgreSQL refuses a value that does not fit the column's type when the statement is bound, rows or none.
    for (const filter of filters) {
      const type = all.find((c) => c.name === filter.column)?.dataType ?? "text";
      if (filter.value !== undefined && isNumericType(type) && Number.isNaN(Number(filter.value))) {
        if (filter.op !== "contains" && filter.op !== "starts_with") {
          throw new DatabaseError("invalid_request");
        }
      }
    }
    if (all.length === 0) return empty(order, sort, filters);

    const storedAll = Object.hasOwn(this.data.rows, mapKey) ? this.data.rows[mapKey]! : [];
    const stored =
      filters.length === 0
        ? storedAll
        : storedAll.filter((row) =>
            filters.every((filter) =>
              this.matchesFilter(
                all.find((c) => c.name === filter.column)?.dataType ?? "text",
                row[filter.column] ?? null,
                filter,
              ),
            ),
          );
    let rows = stored;
    let start = 0;
    let offset = 0;
    let limit = pageSize;
    if (key) {
      const keyOf = (row: Record<string, string | null>): string[] =>
        key.columns.map((c) => row[c] ?? "");
      const byKey = (a: Record<string, string | null>, b: Record<string, string | null>): number =>
        this.compareKeys(mapKey, keyOf(a), keyOf(b), key.columns);
      const sortType = sort
        ? (all.find((c) => c.name === sort.column)?.dataType ?? "text")
        : "text";
      // The order the database gives: ascending puts NULL last, descending puts it first; the key breaks ties.
      const bySort = (
        a: Record<string, string | null>,
        b: Record<string, string | null>,
      ): number => {
        if (!sort) return 0;
        const x = a[sort.column] ?? null;
        const y = b[sort.column] ?? null;
        const ascending = this.compareValues(sortType, x, y);
        return sort.direction === "asc" ? ascending : -ascending;
      };
      const ordered = (
        a: Record<string, string | null>,
        b: Record<string, string | null>,
      ): number => bySort(a, b) || byKey(a, b);
      rows = [...stored].sort(ordered);
      if (cursor) {
        if (
          cursor.kind !== "keyset" ||
          cursor.values.length !== key.columns.length ||
          (cursor.sort !== undefined) !== (sort !== null)
        ) {
          throw new DatabaseError("invalid_request");
        }
        // A stand-in row for "the last row of the previous page".
        const after: Record<string, string | null> = {};
        if (sort && cursor.sort) after[sort.column] = cursor.sort.value;
        key.columns.forEach((c, i) => {
          after[c] = cursor.values[i] ?? "";
        });
        start = rows.findIndex((r) => ordered(r, after) > 0);
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
      sortValue: sort ? cutSortValue(row[sort.column] ?? null) : undefined,
    }));
    return buildRowPage({
      columns,
      hiddenColumns: all.length - shown.length,
      order,
      rawRows,
      pageSize: limit,
      offset,
      rowSecurity,
      sort,
      filters,
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

  /** One condition, the way the database answers it (a comparison with NULL is never true; `neq` also matches NULL). */
  private matchesFilter(type: string, value: string | null, filter: RowFilter): boolean {
    if (filter.op === "is_null") return value === null;
    if (filter.op === "is_not_null") return value !== null;
    const wanted = filter.value ?? "";
    if (filter.op === "contains") {
      return value !== null && value.toLowerCase().includes(wanted.toLowerCase());
    }
    if (filter.op === "starts_with") {
      return value !== null && value.toLowerCase().startsWith(wanted.toLowerCase());
    }
    const compared = value === null ? null : this.compareValues(type, value, wanted);
    switch (filter.op) {
      case "eq":
        return compared === 0;
      case "neq":
        return compared === null || compared !== 0;
      case "gt":
        return compared !== null && compared > 0;
      case "gte":
        return compared !== null && compared >= 0;
      case "lt":
        return compared !== null && compared < 0;
      default:
        return compared !== null && compared <= 0;
    }
  }

  /** Compare two values of one column, ascending, with NULL after every value (as the database does). */
  private compareValues(type: string, x: string | null, y: string | null): number {
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const numeric = /^(smallint|integer|bigint|numeric|real|double precision)/.test(type);
    const result = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    return result < 0 ? -1 : result > 0 ? 1 : 0;
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

  async getSizes(options: { schema?: string; limit: number }): Promise<DatabaseSizes> {
    this.requireConnection();
    // Made up, in the shape of the real thing: 8 KB of heap and 16 KB of indexes per table, no row read.
    const all = this.data.tables
      .filter((t) => t.kind === "table" || t.kind === "materialized_view")
      .filter((t) => options.schema === undefined || t.schema === options.schema)
      .map((t) => ({
        schema: t.schema,
        name: t.name,
        kind: (t.kind === "materialized_view" ? "materialized" : "table") as
          "table" | "materialized",
        totalBytes: 24576,
        tableBytes: 8192,
        indexBytes: 16384,
        estimatedRows: t.estimatedRowCount,
      }));
    const perSchema = new Map<string, { schema: string; totalBytes: number; tables: number }>();
    for (const t of all) {
      const s = perSchema.get(t.schema) ?? { schema: t.schema, totalBytes: 0, tables: 0 };
      s.totalBytes += t.totalBytes;
      s.tables += 1;
      perSchema.set(t.schema, s);
    }
    return {
      databaseBytes: 8_000_000 + all.length * 24576,
      schemas: [...perSchema.values()],
      tables: all.slice(0, options.limit),
      tableCount: all.length,
    };
  }

  async getTableStatistics(table: TableRef): Promise<TableStatistics | null> {
    this.requireConnection();
    const info = this.data.tables.find((t) => t.schema === table.schema && t.name === table.name);
    if (!info || (info.kind !== "table" && info.kind !== "materialized_view")) return null;
    // Made up, in the shape of the real thing: every column has figures, none is a value.
    return {
      table: { schema: table.schema, name: table.name },
      kind: info.kind === "materialized_view" ? "materialized" : "table",
      estimatedRows: info.estimatedRowCount,
      liveRows: info.estimatedRowCount,
      deadRows: 0,
      tableBytes: 8192,
      indexBytes: 16384,
      toastBytes: 0,
      lastVacuum: null,
      lastAutovacuum: null,
      lastAnalyze: "2026-01-01T00:00:00.000Z",
      lastAutoanalyze: null,
      columns: this.lookup(this.data.columns, table.schema, table.name).map((c) => ({
        column: c.name,
        hasStatistics: true,
        nullFraction: c.nullable ? 0.1 : 0,
        distinctValues: null,
        distinctShare: 1,
        averageWidth: 4,
        correlation: 0,
      })),
    };
  }

  async getRoleInfo(): Promise<RoleInfo> {
    this.requireConnection();
    return copy(this.role);
  }

  // ---- WritableAdapter (see mock-writes.ts for what the mock does and does not check).

  async describeForEdit(table: TableRef): Promise<TableEditInfo> {
    this.requireConnection();
    return copy(this.writes.describeForEdit(table));
  }

  async previewChange(change: Change): Promise<PlannedChange> {
    this.requireConnection();
    return copy(this.writes.previewChange(copy(change)));
  }

  async applyChange(plan: PlannedChange, signal?: CancelSignal): Promise<AppliedChange> {
    this.requireConnection();
    // As the PostgreSQL adapter: a change cancelled before it runs is refused, and nothing is applied.
    if (signal?.aborted)
      throw new DatabaseError("unexpected", { message: "The change was cancelled." });
    return this.writes.applyChange(copy(plan));
  }

  /** Structure changes that were applied without changing the sample data (for tests). */
  get appliedStructureChanges(): readonly StructureChange[] {
    return this.writes.appliedStructure;
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
