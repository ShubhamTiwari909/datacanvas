/**
 * @datacanvas/database-core
 *
 * Database-agnostic building blocks: metadata models, the adapter interface,
 * typed errors and the provider registry.
 *
 * RULES for this package (enforced by tests/architecture.test.ts):
 *  - no runtime dependencies at all;
 *  - no imports of database drivers (pg, mongodb, ...) or of Next.js/React.
 */
export * from "./models.js";
export * from "./errors.js";
export * from "./adapter.js";
export * from "./registry.js";
export * from "./table-refs.js";
export * from "./structure.js";
export * from "./objects.js";
export * from "./sql-text.js";
export * from "./rows.js";
export * from "./diff.js";
export * from "./changes.js";
export * from "./sql-run.js";
