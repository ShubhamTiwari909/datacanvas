/**
 * Sample database used by the mock adapter: a small online shop.
 *
 *   users ◄── orders ◄── order_items ──► products
 *
 * It mirrors the PostgreSQL test database that examples/ecommerce.sql creates, so the same
 * expectations will hold for the mock and the real adapter.
 *
 * Contents: schema "public" with tables users, products, orders, order_items
 * and the view active_users; schema "analytics" with the materialized view
 * daily_sales (so all three relation kinds appear).
 */
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseObjects,
  IndexInfo,
  IndexUsageReport,
  RelationshipInfo,
  SchemaInfo,
  TableInfo,
} from "../models.js";

/** Everything one mock database knows about, keyed like the adapter methods. */
export interface MockDatabaseData {
  schemas: SchemaInfo[];
  tables: TableInfo[];
  /** Keyed by "schema.table". */
  columns: Record<string, ColumnInfo[]>;
  constraints: Record<string, ConstraintInfo[]>;
  indexes: Record<string, IndexInfo[]>;
  relationships: RelationshipInfo[];
  /** Views, types, sequences, functions, triggers, extensions and policies. */
  objects: DatabaseObjects;
  /** Counters for the indexes of the sample tables. */
  indexUsage: IndexUsageReport;
}

function column(
  position: number,
  name: string,
  dataType: string,
  options: { nullable?: boolean; defaultValue?: string; comment?: string } = {},
): ColumnInfo {
  return {
    name,
    ordinalPosition: position,
    dataType,
    nullable: options.nullable ?? false,
    defaultValue: options.defaultValue ?? null,
    comment: options.comment ?? null,
  };
}

function table(
  schema: string,
  name: string,
  kind: TableInfo["kind"],
  rows: number | null,
): TableInfo {
  return { schema, name, kind, comment: null, estimatedRowCount: rows };
}

function index(
  name: string,
  tableName: string,
  columns: string[],
  options: { unique?: boolean; primary?: boolean } = {},
): IndexInfo {
  const unique = options.unique ?? options.primary ?? false;
  return {
    name,
    columns,
    unique,
    primary: options.primary ?? false,
    method: "btree",
    definition: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON public.${tableName} USING btree (${columns.join(", ")})`,
  };
}

function usage(
  index: string,
  table: string,
  scans: number,
  sizeBytes: number,
  backsConstraint: boolean,
): IndexUsageReport["indexes"][number] {
  return { schema: "public", table, index, scans, sizeBytes, backsConstraint, valid: true };
}

const idColumn = (): ColumnInfo =>
  column(1, "id", "integer", { defaultValue: "nextval('id_seq'::regclass)" });

/** Build a fresh copy of the sample data. Each call returns independent objects. */
export function createEcommerceData(): MockDatabaseData {
  return {
    schemas: [{ name: "analytics" }, { name: "public" }],

    tables: [
      table("analytics", "daily_sales", "materialized_view", null),
      table("public", "active_users", "view", null),
      table("public", "order_items", "table", 5200),
      table("public", "orders", "table", 1800),
      table("public", "products", "table", 120),
      table("public", "users", "table", 450),
    ],

    columns: {
      "public.users": [
        idColumn(),
        column(2, "email", "text"),
        column(3, "full_name", "text", { nullable: true }),
        column(4, "created_at", "timestamp with time zone", { defaultValue: "now()" }),
      ],
      "public.products": [
        idColumn(),
        column(2, "sku", "text"),
        column(3, "name", "text"),
        column(4, "price_cents", "integer"),
      ],
      "public.orders": [
        idColumn(),
        column(2, "user_id", "integer"),
        column(3, "status", "text", { defaultValue: "'pending'::text" }),
        column(4, "placed_at", "timestamp with time zone", { defaultValue: "now()" }),
      ],
      "public.order_items": [
        idColumn(),
        column(2, "order_id", "integer"),
        column(3, "product_id", "integer"),
        column(4, "quantity", "integer", { defaultValue: "1" }),
      ],
      "public.active_users": [column(1, "id", "integer"), column(2, "email", "text")],
      "analytics.daily_sales": [
        column(1, "day", "date"),
        column(2, "total_cents", "bigint", { nullable: true }),
      ],
    },

    constraints: {
      "public.users": [
        {
          name: "users_pkey",
          kind: "primary_key",
          columns: ["id"],
          definition: "PRIMARY KEY (id)",
        },
        {
          name: "users_email_key",
          kind: "unique",
          columns: ["email"],
          definition: "UNIQUE (email)",
        },
      ],
      "public.products": [
        {
          name: "products_pkey",
          kind: "primary_key",
          columns: ["id"],
          definition: "PRIMARY KEY (id)",
        },
        { name: "products_sku_key", kind: "unique", columns: ["sku"], definition: "UNIQUE (sku)" },
      ],
      "public.orders": [
        {
          name: "orders_pkey",
          kind: "primary_key",
          columns: ["id"],
          definition: "PRIMARY KEY (id)",
        },
        {
          name: "orders_user_id_fkey",
          kind: "foreign_key",
          columns: ["user_id"],
          definition: "FOREIGN KEY (user_id) REFERENCES users(id)",
        },
      ],
      "public.order_items": [
        {
          name: "order_items_pkey",
          kind: "primary_key",
          columns: ["id"],
          definition: "PRIMARY KEY (id)",
        },
        {
          name: "order_items_order_id_fkey",
          kind: "foreign_key",
          columns: ["order_id"],
          definition: "FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE",
        },
        {
          name: "order_items_product_id_fkey",
          kind: "foreign_key",
          columns: ["product_id"],
          definition: "FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT",
        },
        {
          name: "order_items_quantity_check",
          kind: "check",
          columns: ["quantity"],
          definition: "CHECK ((quantity > 0))",
        },
      ],
      // Views have no constraints of their own.
      "public.active_users": [],
      "analytics.daily_sales": [],
    },

    indexes: {
      "public.users": [
        index("users_pkey", "users", ["id"], { primary: true }),
        index("users_email_key", "users", ["email"], { unique: true }),
      ],
      "public.products": [
        index("products_pkey", "products", ["id"], { primary: true }),
        index("products_sku_key", "products", ["sku"], { unique: true }),
      ],
      "public.orders": [
        index("orders_pkey", "orders", ["id"], { primary: true }),
        index("orders_user_id_idx", "orders", ["user_id"]),
      ],
      "public.order_items": [
        index("order_items_pkey", "order_items", ["id"], { primary: true }),
        index("order_items_order_id_idx", "order_items", ["order_id"]),
      ],
      "public.active_users": [],
      "analytics.daily_sales": [],
    },

    relationships: [
      {
        name: "order_items_order_id_fkey",
        source: { schema: "public", table: "order_items", columns: ["order_id"] },
        target: { schema: "public", table: "orders", columns: ["id"] },
        cardinality: "many-to-one",
        onDelete: "cascade",
        onUpdate: "no_action",
      },
      {
        name: "order_items_product_id_fkey",
        source: { schema: "public", table: "order_items", columns: ["product_id"] },
        target: { schema: "public", table: "products", columns: ["id"] },
        cardinality: "many-to-one",
        onDelete: "restrict",
        onUpdate: "no_action",
      },
      {
        name: "orders_user_id_fkey",
        source: { schema: "public", table: "orders", columns: ["user_id"] },
        target: { schema: "public", table: "users", columns: ["id"] },
        cardinality: "many-to-one",
        onDelete: "no_action",
        onUpdate: "no_action",
      },
    ],

    objects: {
      views: [
        {
          schema: "analytics",
          name: "daily_sales",
          materialized: true,
          comment: null,
          definition:
            " SELECT date_trunc('day'::text, placed_at)::date AS day,\n    sum(oi.quantity * p.price_cents) AS total_cents\n   FROM orders o\n     JOIN order_items oi ON oi.order_id = o.id\n     JOIN products p ON p.id = oi.product_id\n  GROUP BY (date_trunc('day'::text, placed_at)::date);",
          dependsOn: [
            { schema: "public", name: "order_items" },
            { schema: "public", name: "orders" },
            { schema: "public", name: "products" },
          ],
        },
        {
          schema: "public",
          name: "active_users",
          materialized: false,
          comment: null,
          definition:
            " SELECT id,\n    email\n   FROM users\n  WHERE created_at > (now() - '1 year'::interval);",
          dependsOn: [{ schema: "public", name: "users" }],
        },
      ],
      types: [
        {
          schema: "public",
          name: "order_status",
          kind: "enum",
          comment: null,
          values: ["pending", "paid", "shipped", "cancelled"],
          attributes: [],
          baseType: null,
          defaultValue: null,
          constraints: [],
        },
      ],
      sequences: [
        {
          schema: "public",
          name: "users_id_seq",
          dataType: "integer",
          start: "1",
          increment: "1",
          min: "1",
          max: "2147483647",
          cache: "1",
          cycle: false,
          ownedBy: { schema: "public", table: "users", column: "id" },
        },
      ],
      functions: [
        {
          schema: "public",
          name: "touch_updated_at",
          kind: "function",
          arguments: "",
          returns: "trigger",
          language: "plpgsql",
          volatility: "volatile",
          securityDefiner: false,
          comment: null,
          definition:
            "CREATE OR REPLACE FUNCTION public.touch_updated_at()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN NEW.placed_at = now(); RETURN NEW; END $function$\n",
        },
      ],
      triggers: [
        {
          schema: "public",
          table: "orders",
          name: "orders_touch",
          timing: "before",
          events: ["update"],
          level: "row",
          function: "public.touch_updated_at",
          state: "enabled",
          definition:
            "CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at()",
        },
      ],
      extensions: [
        {
          name: "plpgsql",
          version: "1.0",
          schema: "pg_catalog",
          comment: "PL/pgSQL procedural language",
        },
      ],
      policies: [
        {
          schema: "public",
          table: "orders",
          name: "orders_owner_only",
          command: "select",
          permissive: true,
          roles: ["public"],
          using: "(user_id = (current_setting('app.user_id'::text))::integer)",
          withCheck: null,
        },
      ],
      rowSecurity: [{ schema: "public", table: "orders", forced: false }],
    },

    indexUsage: {
      statsReset: "2026-10-01T00:00:00.000Z",
      inRecovery: false,
      indexes: [
        usage("users_pkey", "users", 900, 16384, true),
        usage("users_email_key", "users", 450, 16384, true),
        usage("orders_user_id_idx", "orders", 0, 8192, false),
        usage("order_items_order_id_idx", "order_items", 120, 8192, false),
      ],
    },
  };
}
