import type { ResolvedPostgresConnection } from "@datacanvas/shared-types";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTER_OPTIONS,
  buildPoolConfig,
  resolveAdapterOptions,
  sslModeToPgSsl,
} from "./config.js";

const connection: ResolvedPostgresConnection = {
  name: "Shop",
  host: "db.example.com",
  port: 6543,
  database: "shop",
  username: "alice",
  password: "p@ss",
  sslMode: "verify-full",
};

describe("sslModeToPgSsl", () => {
  it("disables TLS for disable", () => {
    expect(sslModeToPgSsl("disable")).toBe(false);
  });

  it("encrypts without certificate checks for require", () => {
    expect(sslModeToPgSsl("require")).toEqual({ rejectUnauthorized: false });
  });

  it("verifies the certificate for verify-full", () => {
    expect(sslModeToPgSsl("verify-full")).toEqual({ rejectUnauthorized: true });
  });
});

describe("buildPoolConfig", () => {
  it("passes individual fields, never a connection string", () => {
    const config = buildPoolConfig(connection, resolveAdapterOptions());
    expect(config).toMatchObject({
      host: "db.example.com",
      port: 6543,
      database: "shop",
      user: "alice",
      password: "p@ss",
      application_name: "datacanvas",
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("always sets ssl explicitly, so the PGSSLMODE environment variable cannot weaken it", () => {
    const config = buildPoolConfig({ ...connection, sslMode: "disable" }, resolveAdapterOptions());
    expect(Object.hasOwn(config, "ssl")).toBe(true);
    expect(config.ssl).toBe(false);
  });

  it("applies the default limits, and lets callers override them", () => {
    const defaults = buildPoolConfig(connection, resolveAdapterOptions());
    expect(defaults.connectionTimeoutMillis).toBe(DEFAULT_ADAPTER_OPTIONS.connectTimeoutMs);
    expect(defaults.max).toBe(DEFAULT_ADAPTER_OPTIONS.maxConnections);

    const custom = buildPoolConfig(
      connection,
      resolveAdapterOptions({ maxConnections: 1, connectTimeoutMs: 500 }),
    );
    expect(custom.max).toBe(1);
    expect(custom.connectionTimeoutMillis).toBe(500);
  });
});
