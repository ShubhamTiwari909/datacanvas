/**
 * @datacanvas/canvas-engine
 *
 * The geometry and graph logic behind the canvas, kept free of React and of any
 * canvas library so it is easy to test and to reuse (workspace files, export,
 * a future desktop app).
 *
 * RULES (enforced by tests/architecture.test.ts): only relative imports and
 * @datacanvas/database-core types; no React, no @xyflow/*, no browser APIs.
 */
export * from "./constants.js";
export * from "./ids.js";
export * from "./columns.js";
export * from "./layout.js";
export * from "./edges.js";
export * from "./search.js";
export * from "./graph.js";
export * from "./filters.js";
export * from "./pack.js";
