/**
 * Test support: the mock adapter and its sample data.
 *
 * Imported as `@datacanvas/database-core/testing`, a separate entry point so
 * production code never pulls it in by accident.
 */
export { MockDatabaseAdapter, type MockAdapterOptions } from "./mock-adapter.js";
export { createEcommerceData, type MockDatabaseData } from "./ecommerce-fixture.js";
