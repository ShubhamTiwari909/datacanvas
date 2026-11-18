/**
 * Contracts for editing rows and designing tables (1.4.0,
 * `docs/data-editing-plan.md`): the routes under `/api/connections/:id/writes/`
 * and `/api/connections/:id/role`.
 *
 * Every request schema is STRICT at every level: a `sql`, `where`,
 * `expression`, `using` or any other unknown key is refused. A change is a
 * structured operation; the server builds the statement from it. A type test
 * (writes.test.ts) keeps these schemas identical to the database-core types.
 */
import { z } from "zod";
import { identifierSchema } from "./connections.js";

// Limits, mirrored from @datacanvas/database-core (a test keeps them equal).
export const WRITE_MAX_IDENTIFIER_BYTES = 63;
export const WRITE_MAX_CHANGE_COLUMNS = 100;
export const WRITE_MAX_CHANGE_VALUE_CHARS = 100_000;
export const WRITE_MAX_COMMENT_CHARS = 2000;
export const WRITE_MAX_CHANGE_PARTS = 32;
export const WRITE_MAX_TYPE_LENGTH = 10_485_760;
export const WRITE_MAX_NUMERIC_PRECISION = 1000;
/** The largest preview request body: a row change can carry long values. */
export const WRITE_MAX_BODY_BYTES = 1024 * 1024;

function utf8Bytes(name: string): number {
  let bytes = 0;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * A NEW name (a table, a column, a rename): not empty, at most 63 bytes, no
 * NUL, no leading or trailing space. Messages never echo the name.
 */
export const newIdentifierSchema = z
  .string()
  .min(1, "A name is needed.")
  .refine(
    (name) => utf8Bytes(name) <= WRITE_MAX_IDENTIFIER_BYTES,
    "A name can be at most 63 bytes.",
  )
  .refine((name) => !name.includes("\0"), "A name cannot contain a NUL character.")
  .refine((name) => name.trim() === name, "A name cannot start or end with a space.");

const tableSchema = z.strictObject({ schema: identifierSchema, name: identifierSchema });
const valueSchema = z.string().max(WRITE_MAX_CHANGE_VALUE_CHARS).nullable();
const columnValueSchema = z.strictObject({ column: identifierSchema, value: valueSchema });
const keyValueSchema = z.strictObject({
  column: identifierSchema,
  value: z.string().max(WRITE_MAX_CHANGE_VALUE_CHARS),
});
const columnListSchema = z.array(identifierSchema).min(1).max(WRITE_MAX_CHANGE_PARTS);

/** Each column at most once in a list of names or values. */
function uniqueColumns<T>(list: T[], name: (item: T) => string): boolean {
  return new Set(list.map(name)).size === list.length;
}

// ------------------------------------------------------------ row changes ---

export const updateRowChangeSchema = z
  .strictObject({
    kind: z.literal("update_row"),
    table: tableSchema,
    key: z.array(keyValueSchema).min(1).max(WRITE_MAX_CHANGE_PARTS),
    set: z.array(columnValueSchema).min(1).max(WRITE_MAX_CHANGE_COLUMNS),
    expected: z.array(columnValueSchema).max(WRITE_MAX_CHANGE_COLUMNS),
  })
  .refine((c) => uniqueColumns(c.key, (k) => k.column), "A key column is listed twice.")
  .refine((c) => uniqueColumns(c.set, (v) => v.column), "A column is changed twice.")
  .refine(
    (c) =>
      c.expected.length === c.set.length &&
      c.set.every((v) => c.expected.some((e) => e.column === v.column)),
    "Every changed column needs the value that was seen.",
  );

export const insertRowChangeSchema = z
  .strictObject({
    kind: z.literal("insert_row"),
    table: tableSchema,
    values: z.array(columnValueSchema).max(WRITE_MAX_CHANGE_COLUMNS),
  })
  .refine((c) => uniqueColumns(c.values, (v) => v.column), "A column is listed twice.");

export const deleteRowChangeSchema = z
  .strictObject({
    kind: z.literal("delete_row"),
    table: tableSchema,
    key: z.array(keyValueSchema).min(1).max(WRITE_MAX_CHANGE_PARTS),
  })
  .refine((c) => uniqueColumns(c.key, (k) => k.column), "A key column is listed twice.");

// ------------------------------------------------------- column definitions ---

export const COLUMN_TYPE_NAME_LIST = [
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "boolean",
  "text",
  "varchar",
  "char",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "json",
  "jsonb",
  "bytea",
  "inet",
] as const;

export const columnTypeSchema = z
  .strictObject({
    name: z.enum(COLUMN_TYPE_NAME_LIST),
    length: z.number().int().min(1).max(WRITE_MAX_TYPE_LENGTH).optional(),
    precision: z.number().int().min(1).max(WRITE_MAX_NUMERIC_PRECISION).optional(),
    scale: z.number().int().min(0).max(WRITE_MAX_NUMERIC_PRECISION).optional(),
    array: z.boolean().optional(),
  })
  .refine(
    (t) => t.length === undefined || t.name === "varchar" || t.name === "char",
    "Only varchar and char take a length.",
  )
  .refine(
    (t) => (t.precision === undefined && t.scale === undefined) || t.name === "numeric",
    "Only numeric takes a precision and a scale.",
  )
  .refine((t) => t.scale === undefined || t.precision !== undefined, "A scale needs a precision.")
  .refine(
    (t) => t.scale === undefined || t.precision === undefined || t.scale <= t.precision,
    "The scale cannot be larger than the precision.",
  );

export const columnDefaultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("literal"),
    value: z.string().max(WRITE_MAX_CHANGE_VALUE_CHARS),
  }),
  z.strictObject({ kind: z.literal("now") }),
  z.strictObject({ kind: z.literal("current_date") }),
  z.strictObject({ kind: z.literal("gen_random_uuid") }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
]);

const commentSchema = z.string().max(WRITE_MAX_COMMENT_CHARS).nullable();

export const columnDefinitionSchema = z
  .strictObject({
    name: newIdentifierSchema,
    type: columnTypeSchema,
    nullable: z.boolean(),
    default: columnDefaultSchema,
    identity: z.enum(["always", "by_default"]).nullable(),
    comment: commentSchema,
  })
  .refine(
    (c) => c.identity === null || c.default.kind === "none",
    "An identity column cannot also have a default.",
  )
  .refine(
    (c) =>
      c.identity === null ||
      (["smallint", "integer", "bigint"].includes(c.type.name) && c.type.array !== true),
    "Only smallint, integer and bigint can be an identity column.",
  );

export const referentialActionInputSchema = z.enum([
  "no_action",
  "restrict",
  "cascade",
  "set_null",
  "set_default",
]);

export const foreignKeyDefinitionSchema = z
  .strictObject({
    columns: columnListSchema,
    references: z.strictObject({
      schema: identifierSchema,
      table: identifierSchema,
      columns: columnListSchema,
    }),
    onDelete: referentialActionInputSchema,
    onUpdate: referentialActionInputSchema,
  })
  .refine(
    (f) => f.columns.length === f.references.columns.length,
    "A foreign key needs as many referenced columns as columns.",
  );

// ------------------------------------------------------- structure changes ---

export const createTableChangeSchema = z
  .strictObject({
    kind: z.literal("create_table"),
    schema: identifierSchema,
    name: newIdentifierSchema,
    columns: z.array(columnDefinitionSchema).min(1).max(WRITE_MAX_CHANGE_COLUMNS),
    primaryKey: z.array(identifierSchema).max(WRITE_MAX_CHANGE_PARTS),
    unique: z.array(columnListSchema).max(WRITE_MAX_CHANGE_PARTS),
    foreignKeys: z.array(foreignKeyDefinitionSchema).max(WRITE_MAX_CHANGE_PARTS),
    comment: commentSchema,
  })
  .refine((c) => uniqueColumns(c.columns, (col) => col.name), "Two columns have the same name.");

export const addColumnChangeSchema = z.strictObject({
  kind: z.literal("add_column"),
  table: tableSchema,
  column: columnDefinitionSchema,
});
export const renameColumnChangeSchema = z.strictObject({
  kind: z.literal("rename_column"),
  table: tableSchema,
  column: identifierSchema,
  to: newIdentifierSchema,
});
export const renameTableChangeSchema = z.strictObject({
  kind: z.literal("rename_table"),
  table: tableSchema,
  to: newIdentifierSchema,
});
export const alterColumnTypeChangeSchema = z.strictObject({
  kind: z.literal("alter_column_type"),
  table: tableSchema,
  column: identifierSchema,
  type: columnTypeSchema,
});
export const setNullableChangeSchema = z.strictObject({
  kind: z.literal("set_nullable"),
  table: tableSchema,
  column: identifierSchema,
  nullable: z.boolean(),
});
export const setDefaultChangeSchema = z.strictObject({
  kind: z.literal("set_default"),
  table: tableSchema,
  column: identifierSchema,
  default: columnDefaultSchema,
});
export const addPrimaryKeyChangeSchema = z.strictObject({
  kind: z.literal("add_primary_key"),
  table: tableSchema,
  columns: columnListSchema,
});
export const addUniqueChangeSchema = z.strictObject({
  kind: z.literal("add_unique"),
  table: tableSchema,
  columns: columnListSchema,
});
export const addForeignKeyChangeSchema = z.strictObject({
  kind: z.literal("add_foreign_key"),
  table: tableSchema,
  foreignKey: foreignKeyDefinitionSchema,
});
export const dropConstraintChangeSchema = z.strictObject({
  kind: z.literal("drop_constraint"),
  table: tableSchema,
  constraint: identifierSchema,
});
export const createIndexChangeSchema = z.strictObject({
  kind: z.literal("create_index"),
  table: tableSchema,
  columns: columnListSchema,
  unique: z.boolean(),
});
export const dropIndexChangeSchema = z.strictObject({
  kind: z.literal("drop_index"),
  table: tableSchema,
  index: identifierSchema,
});
export const dropColumnChangeSchema = z.strictObject({
  kind: z.literal("drop_column"),
  table: tableSchema,
  column: identifierSchema,
  confirm: z.string().max(255),
});
export const dropTableChangeSchema = z.strictObject({
  kind: z.literal("drop_table"),
  table: tableSchema,
  confirm: z.string().max(255),
});

/** Any change. Strict at every level; the kind picks the shape. */
export const changeSchema = z.discriminatedUnion("kind", [
  updateRowChangeSchema,
  insertRowChangeSchema,
  deleteRowChangeSchema,
  createTableChangeSchema,
  addColumnChangeSchema,
  renameColumnChangeSchema,
  renameTableChangeSchema,
  alterColumnTypeChangeSchema,
  setNullableChangeSchema,
  setDefaultChangeSchema,
  addPrimaryKeyChangeSchema,
  addUniqueChangeSchema,
  addForeignKeyChangeSchema,
  dropConstraintChangeSchema,
  createIndexChangeSchema,
  dropIndexChangeSchema,
  dropColumnChangeSchema,
  dropTableChangeSchema,
]);
export type ChangeInput = z.infer<typeof changeSchema>;

// ---------------------------------------------------------------- requests ---

/** `POST .../writes/unlock`: the database name, typed by the person. */
export const unlockWritesRequestSchema = z.strictObject({ database: z.string().max(255) });
export type UnlockWritesRequest = z.infer<typeof unlockWritesRequestSchema>;

/** `POST .../writes/preview`. */
export const previewChangeRequestSchema = z.strictObject({ change: changeSchema });
export type PreviewChangeRequest = z.infer<typeof previewChangeRequestSchema>;

/** A preview id: unguessable, URL-safe. */
export const previewIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/** `POST .../writes/apply`: only the id; the change itself stays on the server. */
export const applyChangeRequestSchema = z.strictObject({ previewId: previewIdSchema });
export type ApplyChangeRequest = z.infer<typeof applyChangeRequestSchema>;

/** `POST .../writes/edit-info`: which table. */
export const editInfoRequestSchema = z.strictObject({
  schema: identifierSchema,
  table: identifierSchema,
});

// --------------------------------------------------------------- responses ---

/**
 * Whether writes are possible on a connection, and why not. All four must be
 * true for a change to run (the three layers of decision 125, plus data viewing).
 */
export const writesStatusSchema = z.object({
  /** DataCanvas was started with `--enable-writes`. */
  enabled: z.boolean(),
  /** The connection's host is this machine (`localhost`, `127.0.0.0/8` or `::1`). */
  local: z.boolean(),
  /** Viewing table data is on for the connection. */
  dataAccess: z.boolean(),
  /** The person unlocked writes for this connection in this session. */
  unlocked: z.boolean(),
});
export type WritesStatus = z.infer<typeof writesStatusSchema>;
export const writesStatusResponseSchema = z.object({ writes: writesStatusSchema });

const changeWarningSchema = z.object({
  code: z.enum([
    "triggers",
    "row_security",
    "referenced",
    "lock",
    "rewrite",
    "scan",
    "renamed",
    "destructive",
    "may_fail",
    "lossy",
  ]),
  message: z.string(),
});

/** What the browser sees of a planned change. The parameters (the values) are not sent back. */
export const changePreviewSchema = z.object({
  previewId: previewIdSchema,
  /** The statements exactly as they will run; values appear as $1, $2, ... */
  statement: z.string(),
  effect: z.string(),
  warnings: z.array(changeWarningSchema),
  destructive: z.boolean(),
  category: z.enum(["row", "structure"]),
  /** ISO time after which the preview can no longer be applied. */
  expiresAt: z.string(),
});
export type ChangePreview = z.infer<typeof changePreviewSchema>;
export const previewChangeResponseSchema = z.object({ preview: changePreviewSchema });

/** One line of the session history: names only, never values (decision 131). */
export const historyEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.string(),
  table: z.object({ schema: z.string(), name: z.string() }),
  columns: z.array(z.string()),
  /** The SQL, for a change of structure only (a row change's SQL is not kept). */
  statement: z.string().nullable(),
  outcome: z.enum(["applied", "failed"]),
  errorCode: z.string().nullable(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const applyChangeResponseSchema = z.object({
  result: z.object({ rowCount: z.number(), entry: historyEntrySchema }),
});
/** The migration file of a session: the changes of structure as SQL (decision 138). */
export const migrationFileSchema = z.object({
  filename: z.string(),
  script: z.string(),
  steps: z.number(),
  /** Earlier steps left out because the session kept only the latest ones. */
  omittedSteps: z.number(),
  rowChanges: z.number(),
});
export type MigrationFile = z.infer<typeof migrationFileSchema>;
export const migrationResponseSchema = z.object({ migration: migrationFileSchema });

export const historyResponseSchema = z.object({ history: z.array(historyEntrySchema) });

export const tableEditInfoSchema = z.object({
  table: z.object({ schema: z.string(), name: z.string() }),
  editable: z.boolean(),
  reason: z
    .enum(["not_a_table", "no_key", "foreign_table", "partition_of_other", "not_found"])
    .nullable(),
  key: z.array(z.string()),
  columns: z.array(
    z.object({
      name: z.string(),
      dataType: z.string(),
      nullable: z.boolean(),
      hasDefault: z.boolean(),
      generated: z.boolean(),
      identity: z.enum(["always", "by_default"]).nullable(),
      editable: z.boolean(),
      inKey: z.boolean(),
    }),
  ),
  triggers: z.array(z.string()),
  rowSecurity: z.boolean(),
  incomingForeignKeys: z.array(
    z.object({
      name: z.string(),
      from: z.object({ schema: z.string(), table: z.string(), columns: z.array(z.string()) }),
      columns: z.array(z.string()),
      onDelete: referentialActionInputSchema,
      onUpdate: referentialActionInputSchema,
    }),
  ),
});
export const editInfoResponseSchema = z.object({ info: tableEditInfoSchema });

export const roleInfoSchema = z.object({
  roleName: z.string(),
  superuser: z.boolean(),
  createRole: z.boolean(),
  createDb: z.boolean(),
  bypassRls: z.boolean(),
  powerfulRoles: z.array(z.string()),
  canCreateInDatabase: z.boolean(),
  schemasWithCreate: z.number(),
  writableTables: z.number(),
  serverAddress: z.string().nullable(),
});

const roleWarningSchema = z.object({
  code: z.enum([
    "superuser",
    "can_write",
    "can_create",
    "create_role",
    "create_db",
    "bypass_rls",
    "server_files",
  ]),
  message: z.string(),
});

/** `GET /api/connections/:id/role`: what the role can do, and the warnings for each mode. */
export const roleResponseSchema = z.object({
  role: roleInfoSchema,
  warnings: z.object({ read: z.array(roleWarningSchema), write: z.array(roleWarningSchema) }),
});
export type RoleResponse = z.infer<typeof roleResponseSchema>;
