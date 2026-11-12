import { describe, expect, it } from "vitest";
import { POST } from "./route";

const SECRET = "hunter2-very-secret";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://127.0.0.1:4747/api/connections/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/connections/validate", () => {
  it("accepts a valid connection string and returns a password-free summary", async () => {
    const response = await post({
      mode: "string",
      name: "Shop",
      connectionString: `postgresql://alice:${SECRET}@db.example.com:5433/shop?sslmode=require`,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      connection: {
        name: "Shop",
        host: "db.example.com",
        port: 5433,
        database: "shop",
        username: "alice",
        sslMode: "require",
        hasPassword: true,
      },
    });
    // The password must not appear anywhere in the response.
    expect(text).not.toContain(SECRET);
  });

  it("accepts fields mode and applies defaults", async () => {
    const response = await post({
      mode: "fields",
      name: "Local",
      host: "localhost",
      database: "app",
      username: "me",
    });
    expect((await response.json()).connection).toMatchObject({
      port: 5432,
      sslMode: "verify-full",
      hasPassword: false,
    });
  });

  it("returns a readable 400 for an invalid connection string, without echoing it", async () => {
    const response = await post({
      mode: "string",
      name: "Shop",
      connectionString: `mysql://alice:${SECRET}@db/shop`,
    });
    const text = await response.text();
    const body = JSON.parse(text);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.issues[0].path).toBe("connectionString");
    expect(body.error.issues[0].message).toMatch(/postgresql:\/\//);
    expect(text).not.toContain(SECRET);
  });

  it("reports every invalid field at once", async () => {
    const response = await post({ mode: "fields", name: "", host: "", database: "", username: "" });
    const paths = (await response.json()).error.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "host", "database", "username"]));
  });
});
