import { describe, expect, it } from "vitest";
import {
  defaultSslMode,
  parsePostgresConnectionString,
  postgresConnectionInputSchema,
  resolvePostgresConnection,
  summarizePostgresConnection,
} from "./postgres-connection.js";

const SECRET = "s3cr3t-P@ss/word";
const encodedSecret = encodeURIComponent(SECRET);

describe("parsePostgresConnectionString", () => {
  it("parses a full URL", () => {
    const result = parsePostgresConnectionString(
      "postgresql://alice:pw@db.example.com:6543/shop?sslmode=require",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        host: "db.example.com",
        port: 6543,
        database: "shop",
        username: "alice",
        password: "pw",
        sslMode: "require",
      },
    });
  });

  it("accepts the postgres:// scheme and defaults the port to 5432", () => {
    const result = parsePostgresConnectionString("postgres://bob@localhost/app");
    expect(result.ok && result.value.port).toBe(5432);
    expect(result.ok && result.value.password).toBe("");
  });

  it("decodes percent-encoded passwords", () => {
    const result = parsePostgresConnectionString(`postgresql://u:${encodedSecret}@h/db`);
    expect(result.ok && result.value.password).toBe(SECRET);
  });

  it("strips the brackets from IPv6 hosts", () => {
    const result = parsePostgresConnectionString("postgresql://u:p@[::1]:5432/db");
    expect(result.ok && result.value.host).toBe("::1");
  });

  it("defaults to verify-full when sslmode is absent (never silently unencrypted)", () => {
    const result = parsePostgresConnectionString("postgresql://u:p@h/db");
    expect(result.ok && result.value.sslMode).toBe("verify-full");
  });

  it("defaults to disable for connections to this machine, since nothing crosses a network", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"]) {
      const result = parsePostgresConnectionString(`postgresql://u:p@${host}/db`);
      expect(result.ok && result.value.sslMode, host).toBe("disable");
    }
  });

  it("lets an explicit sslmode win over the loopback default", () => {
    const result = parsePostgresConnectionString("postgresql://u:p@localhost/db?sslmode=require");
    expect(result.ok && result.value.sslMode).toBe("require");
  });

  it("maps sslmode values and treats verify-ca as verify-full", () => {
    const mode = (value: string) => {
      const r = parsePostgresConnectionString(`postgresql://u:p@h/db?sslmode=${value}`);
      return r.ok ? r.value.sslMode : r.message;
    };
    expect(mode("disable")).toBe("disable");
    expect(mode("verify-ca")).toBe("verify-full");
    expect(mode("prefer")).toMatch(/sslmode must be one of/);
  });

  it("ignores other query parameters", () => {
    const result = parsePostgresConnectionString("postgresql://u:p@h/db?options=-c%20x%3Dy");
    expect(result.ok).toBe(true);
  });

  it.each([
    ["not a url", /does not look like a valid connection string/],
    ["mysql://u:p@h/db", /must start with postgresql/],
    ["postgresql:///db", /no host|does not look/],
    ["postgresql://u:p@h", /no database name/],
    ["postgresql://u:p@h/a/b", /slash/],
    ["postgresql://:p@h/db", /no user name/],
    ["postgresql://u:%zz@h/db", /invalid URL encoding/],
    ["postgresql://u:p@h:0/db", /port/],
  ])("rejects %s", (input, message) => {
    const result = parsePostgresConnectionString(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(message);
  });

  it("never repeats the password in an error message", () => {
    const attempts = [
      `mysql://u:${encodedSecret}@h/db`,
      `postgresql://u:${encodedSecret}@h`,
      `postgresql://u:${encodedSecret}@h/a/b`,
      `postgresql://u:${encodedSecret}@h/db?sslmode=prefer`,
    ];
    for (const attempt of attempts) {
      const result = parsePostgresConnectionString(attempt);
      expect(result.ok).toBe(false);
      const message = result.ok ? "" : result.message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(encodedSecret);
    }
  });
});

describe("postgresConnectionInputSchema", () => {
  it("applies defaults in fields mode", () => {
    const result = postgresConnectionInputSchema.parse({
      mode: "fields",
      name: " Local ",
      host: "localhost",
      database: "app",
      username: "me",
    });
    expect(result).toMatchObject({ name: "Local", port: 5432, password: "" });
    // The SSL mode is not decided by the schema: the host decides when resolving.
    expect(result).not.toHaveProperty("sslMode");
  });

  it("rejects an out-of-range port, an empty host and unknown keys", () => {
    const base = { mode: "fields", name: "x", host: "h", database: "d", username: "u" };
    expect(postgresConnectionInputSchema.safeParse({ ...base, port: 70000 }).success).toBe(false);
    expect(postgresConnectionInputSchema.safeParse({ ...base, host: "  " }).success).toBe(false);
    expect(postgresConnectionInputSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("does not coerce types: a port sent as a string is rejected", () => {
    const result = postgresConnectionInputSchema.safeParse({
      mode: "fields",
      name: "x",
      host: "h",
      database: "d",
      username: "u",
      port: "5432",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown mode", () => {
    expect(postgresConnectionInputSchema.safeParse({ mode: "magic" }).success).toBe(false);
  });

  it("validates the connection string in string mode and reports it on that field", () => {
    const result = postgresConnectionInputSchema.safeParse({
      mode: "string",
      name: "x",
      connectionString: "mysql://u:p@h/db",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["connectionString"]);
    }
  });

  it("does not leak the connection string through validation issues", () => {
    const result = postgresConnectionInputSchema.safeParse({
      mode: "string",
      name: "",
      connectionString: `mysql://u:${encodedSecret}@h/db`,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(encodedSecret);
  });
});

describe("defaultSslMode", () => {
  it("disables TLS only for this machine", () => {
    expect(defaultSslMode("localhost")).toBe("disable");
    expect(defaultSslMode("127.0.0.1")).toBe("disable");
    expect(defaultSslMode("::1")).toBe("disable");
    expect(defaultSslMode("db.example.com")).toBe("verify-full");
    expect(defaultSslMode("10.0.0.5")).toBe("verify-full");
    expect(defaultSslMode("localhost.example.com")).toBe("verify-full");
  });
});

describe("resolve and summarize", () => {
  it("resolves a missing sslMode from the host, and an explicit one wins", () => {
    const base = { mode: "fields", name: "x", database: "d", username: "u" } as const;
    const resolve = (host: string, sslMode?: "disable" | "require" | "verify-full") =>
      resolvePostgresConnection(
        postgresConnectionInputSchema.parse({ ...base, host, ...(sslMode ? { sslMode } : {}) }),
      ).sslMode;

    expect(resolve("localhost")).toBe("disable");
    expect(resolve("db.example.com")).toBe("verify-full");
    expect(resolve("db.example.com", "require")).toBe("require");
    expect(resolve("localhost", "verify-full")).toBe("verify-full");
  });

  it("gives the same normalised shape for both modes", () => {
    const fromString = resolvePostgresConnection(
      postgresConnectionInputSchema.parse({
        mode: "string",
        name: "Shop",
        connectionString: "postgresql://alice:pw@db.example.com:5433/shop?sslmode=disable",
      }),
    );
    const fromFields = resolvePostgresConnection(
      postgresConnectionInputSchema.parse({
        mode: "fields",
        name: "Shop",
        host: "db.example.com",
        port: 5433,
        database: "shop",
        username: "alice",
        password: "pw",
        sslMode: "disable",
      }),
    );
    expect(fromString).toEqual(fromFields);
  });

  it("the summary never contains the password", () => {
    const resolved = resolvePostgresConnection(
      postgresConnectionInputSchema.parse({
        mode: "string",
        name: "Shop",
        connectionString: `postgresql://alice:${encodedSecret}@h/shop`,
      }),
    );
    const summary = summarizePostgresConnection(resolved);
    expect(summary.hasPassword).toBe(true);
    expect(Object.keys(summary)).not.toContain("password");
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });
});
