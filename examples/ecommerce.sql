-- DataCanvas sample database: a small online shop.
--
-- Used by the PostgreSQL adapter's integration tests, and handy for trying
-- DataCanvas by hand:  psql -d mydb -f examples/ecommerce.sql
--
-- The first four tables (users, products, orders, order_items) mirror the
-- in-memory sample database of the mock adapter in @datacanvas/database-core,
-- so one contract test suite can check both. The rest exist to exercise
-- PostgreSQL features that metadata extraction must handle correctly.

--------------------------------------------------------------------------
-- Core shop
--------------------------------------------------------------------------

CREATE TABLE users (
  id         serial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  full_name  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE users IS 'Registered customers';
COMMENT ON COLUMN users.email IS 'Login e-mail address';

CREATE TABLE products (
  id          serial PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  price_cents integer NOT NULL
);

CREATE TABLE orders (
  id        serial PRIMARY KEY,
  user_id   integer NOT NULL REFERENCES users (id),
  status    text NOT NULL DEFAULT 'pending',
  placed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_id_idx ON orders (user_id);

CREATE TABLE order_items (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  quantity   integer NOT NULL DEFAULT 1 CHECK (quantity > 0)
);
CREATE INDEX order_items_order_id_idx ON order_items (order_id);

CREATE VIEW active_users AS
  SELECT id, email FROM users WHERE created_at > now() - interval '1 year';

CREATE SCHEMA analytics;
CREATE MATERIALIZED VIEW analytics.daily_sales AS
  SELECT o.placed_at::date AS day,
         sum(p.price_cents * i.quantity)::bigint AS total_cents
  FROM orders o
  JOIN order_items i ON i.order_id = o.id
  JOIN products p ON p.id = i.product_id
  GROUP BY 1;

--------------------------------------------------------------------------
-- Edge cases for metadata extraction
--------------------------------------------------------------------------

-- One-to-one via the primary key being the foreign key.
CREATE TABLE user_profiles (
  user_id integer PRIMARY KEY REFERENCES users (id),
  bio     text
);

-- A PARTIAL unique index must NOT make orders -> users one-to-one: it is only
-- unique among rows WHERE status = 'open'.
CREATE UNIQUE INDEX orders_one_open_per_user ON orders (user_id) WHERE status = 'open';

-- Composite (two-column) foreign key.
CREATE TABLE regions (
  country_code text NOT NULL,
  region_code  text NOT NULL,
  PRIMARY KEY (country_code, region_code)
);
CREATE TABLE addresses (
  id           serial PRIMARY KEY,
  country_code text NOT NULL,
  region_code  text NOT NULL,
  FOREIGN KEY (country_code, region_code) REFERENCES regions (country_code, region_code)
);

-- Expression index, GIN index, and an index with an INCLUDE column.
CREATE INDEX users_lower_full_name_idx ON users (lower(full_name));
CREATE INDEX products_name_search_idx ON products USING gin (to_tsvector('simple', name));
CREATE UNIQUE INDEX products_sku_include_idx ON products (sku) INCLUDE (name);

-- Partitioned table. The partition must be hidden, and the foreign key (which
-- PostgreSQL copies onto each partition) must be reported once.
CREATE TABLE events (
  id      integer NOT NULL,
  user_id integer REFERENCES users (id),
  at      timestamptz NOT NULL
) PARTITION BY RANGE (at);
CREATE TABLE events_2026 PARTITION OF events
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
