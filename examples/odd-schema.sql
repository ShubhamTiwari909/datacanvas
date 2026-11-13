-- A deliberately awkward schema, to test DataCanvas against what real
-- databases contain and tidy sample databases do not.
--
-- Loaded by packages/postgres-adapter/src/postgres.adapter.odd-schema.test.ts
-- into a throwaway database. Needs PostgreSQL 12 or newer (generated columns
-- need 12; nothing here needs a later version). Every statement is plain SQL
-- with no extensions.

-- ---------------------------------------------------------------- names ---
CREATE SCHEMA "Mixed Case-Schema";
CREATE SCHEMA "ünïcode_schéma";
CREATE SCHEMA other;

CREATE TABLE "Mixed Case-Schema"."Order Items" (
  "ID" integer PRIMARY KEY,
  "Unit Price ($)" numeric(10, 2),
  "weird""quote" text,
  "select" text,
  "день" text
);
COMMENT ON TABLE "Mixed Case-Schema"."Order Items" IS E'Line 1\nLine 2 with "quotes", ''apostrophes'' and 日本語 🚀';
COMMENT ON COLUMN "Mixed Case-Schema"."Order Items"."ID" IS 'The key; <b>not html</b> & so on';

CREATE TABLE "ünïcode_schéma"."ñandú_tabla" (id integer PRIMARY KEY, "名前" text);
CREATE TABLE public."select" (id integer PRIMARY KEY);                  -- a reserved word
CREATE TABLE public."a.b" (id integer PRIMARY KEY);                     -- a dot in the name
CREATE TABLE public."; DROP TABLE users; --" (id integer PRIMARY KEY);  -- looks like an attack, is a name
CREATE TABLE public."🚀" (id integer PRIMARY KEY);
-- The longest name PostgreSQL allows (63 bytes).
CREATE TABLE public.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (id integer PRIMARY KEY);
-- The same table name in two schemas.
CREATE TABLE public.shared_name (id integer PRIMARY KEY);
CREATE TABLE other.shared_name (id integer PRIMARY KEY, public_id integer REFERENCES public.shared_name (id));

-- ---------------------------------------------------------------- types ---
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0);
CREATE DOMAIN email_text AS text CHECK (VALUE LIKE '%@%');
CREATE TYPE address_t AS (street text, city text, zip text);

CREATE TABLE public.typed (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feeling mood NOT NULL DEFAULT 'ok',
  qty positive_int,
  contact email_text,
  home address_t,
  tags text[],
  matrix integer[][],
  window_ tstzrange,
  payload jsonb DEFAULT '{}'::jsonb,
  doubled integer GENERATED ALWAYS AS (id * 2) STORED,
  ip inet,
  nothing_special varchar(40)
);

-- ------------------------------------------------------- table shapes ---
CREATE TABLE public.no_columns ();
CREATE TABLE public.no_primary_key (a integer, b text);
CREATE UNLOGGED TABLE public.unlogged_t (id integer PRIMARY KEY);
CREATE TABLE public.wide (
  id integer PRIMARY KEY
);
DO $$
BEGIN
  FOR i IN 1..300 LOOP
    EXECUTE format('ALTER TABLE public.wide ADD COLUMN c%s integer', i);
  END LOOP;
END $$;
CREATE TEMPORARY TABLE temp_hidden (id integer);   -- lives in pg_temp, must never appear

-- ---------------------------------------------------- foreign keys ---
CREATE TABLE public.fk_parent (a integer, b integer, PRIMARY KEY (a, b));
CREATE TABLE public.fk_composite (
  id integer PRIMARY KEY,
  pa integer,
  pb integer,
  FOREIGN KEY (pa, pb) REFERENCES public.fk_parent (a, b) ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE TABLE public.fk_self (
  id integer PRIMARY KEY,
  parent_id integer REFERENCES public.fk_self (id) ON DELETE SET NULL
);
-- A foreign key to a UNIQUE column that is not the primary key.
CREATE TABLE public.fk_unique_target (id integer PRIMARY KEY, code text UNIQUE);
CREATE TABLE public.fk_by_code (
  id integer PRIMARY KEY,
  code text REFERENCES public.fk_unique_target (code) DEFERRABLE INITIALLY DEFERRED
);
-- A circle: a -> b -> c -> a.
CREATE TABLE public.circle_a (id integer PRIMARY KEY, b_id integer);
CREATE TABLE public.circle_b (id integer PRIMARY KEY, c_id integer);
CREATE TABLE public.circle_c (id integer PRIMARY KEY, a_id integer REFERENCES public.circle_a (id));
ALTER TABLE public.circle_a ADD FOREIGN KEY (b_id) REFERENCES public.circle_b (id);
ALTER TABLE public.circle_b ADD FOREIGN KEY (c_id) REFERENCES public.circle_c (id);
-- Cross-schema, including awkward names.
CREATE TABLE "ünïcode_schéma".cross_ref (
  id integer PRIMARY KEY,
  item_id integer REFERENCES "Mixed Case-Schema"."Order Items" ("ID"),
  sel_id integer REFERENCES public."select" (id)
);
-- A foreign key that is also the primary key (one-to-one).
CREATE TABLE public.one_to_one (id integer PRIMARY KEY REFERENCES public.fk_unique_target (id));

-- ------------------------------------------- inheritance, partitions ---
CREATE TABLE public.animals (id integer, name text);
CREATE TABLE public.dogs (breed text) INHERITS (public.animals);

CREATE TABLE public.measurements (
  id integer NOT NULL,
  region text NOT NULL,
  taken date NOT NULL,
  PRIMARY KEY (id, region, taken)
) PARTITION BY LIST (region);
CREATE TABLE public.measurements_eu PARTITION OF public.measurements
  FOR VALUES IN ('eu') PARTITION BY RANGE (taken);
CREATE TABLE public.measurements_eu_2025 PARTITION OF public.measurements_eu
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE public.measurements_us PARTITION OF public.measurements FOR VALUES IN ('us');
CREATE TABLE public.measurement_notes (
  id integer PRIMARY KEY,
  m_id integer, m_region text, m_taken date,
  FOREIGN KEY (m_id, m_region, m_taken) REFERENCES public.measurements (id, region, taken)
);
CREATE TABLE public.hash_parted (id integer, v text) PARTITION BY HASH (id);
CREATE TABLE public.hash_parted_0 PARTITION OF public.hash_parted FOR VALUES WITH (MODULUS 2, REMAINDER 0);
CREATE TABLE public.hash_parted_1 PARTITION OF public.hash_parted FOR VALUES WITH (MODULUS 2, REMAINDER 1);

-- ------------------------------------------------------------- views ---
CREATE VIEW public.v_typed AS SELECT id, feeling FROM public.typed;
CREATE VIEW public.v_of_view AS SELECT id FROM public.v_typed;
CREATE MATERIALIZED VIEW public.mv_counts AS SELECT count(*) AS n FROM public.typed;
COMMENT ON VIEW public.v_typed IS 'A view with a comment';
CREATE VIEW "Mixed Case-Schema"."Odd View" AS SELECT "ID" AS "My ID" FROM "Mixed Case-Schema"."Order Items";

-- ----------------------------------------------------------- indexes ---
CREATE INDEX typed_expr_idx ON public.typed (lower(contact));
CREATE INDEX typed_partial_idx ON public.typed (qty) WHERE qty > 10;
CREATE INDEX typed_include_idx ON public.typed (id) INCLUDE (qty, feeling);
CREATE INDEX typed_gin_idx ON public.typed USING gin (tags);
CREATE INDEX typed_brin_idx ON public.typed USING brin (id);
CREATE UNIQUE INDEX typed_multi_unique ON public.typed (feeling, qty);

-- -------------------------------------------- foreign data (not shown) ---
-- A foreign table needs an extension; file_fdw ships with PostgreSQL's
-- contrib package, which is not always installed, so the test creates it only
-- when available (see the test file).
