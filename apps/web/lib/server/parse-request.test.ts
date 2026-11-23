import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody } from "./parse-request";

const schema = z.strictObject({ name: z.string().min(1) });

function jsonRequest(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4747/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

async function errorOf(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("parseJsonBody and a body cut on the way", () => {
  it("answers 413, not invalid JSON, when the body is shorter than the client said", async () => {
    const full = JSON.stringify({ name: "x".repeat(500) });
    const request = jsonRequest(full.slice(0, 100), { "Content-Length": String(full.length) });
    const result = await parseJsonBody(request, schema);
    expect(!result.ok && (await errorOf(result.response))).toMatchObject({
      status: 413,
      body: { error: { code: "payload_too_large" } },
    });
  });
});

describe("parseJsonBody", () => {
  it("returns typed data for a valid body", async () => {
    const result = await parseJsonBody(jsonRequest('{"name":"a"}'), schema);
    expect(result).toEqual({ ok: true, data: { name: "a" } });
  });

  it("accepts a charset parameter on the content type", async () => {
    const request = jsonRequest('{"name":"a"}', {
      "Content-Type": "application/json; charset=utf-8",
    });
    expect((await parseJsonBody(request, schema)).ok).toBe(true);
  });

  it("rejects a non-JSON content type with 415", async () => {
    const request = jsonRequest('{"name":"a"}', { "Content-Type": "text/plain" });
    const result = await parseJsonBody(request, schema);
    expect(!result.ok && (await errorOf(result.response))).toMatchObject({
      status: 415,
      body: { error: { code: "unsupported_media_type" } },
    });
  });

  it("rejects malformed JSON with 400 invalid_json", async () => {
    const result = await parseJsonBody(jsonRequest("{not json"), schema);
    expect(!result.ok && (await errorOf(result.response))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_json" } },
    });
  });

  it("rejects an empty body as invalid JSON", async () => {
    const result = await parseJsonBody(jsonRequest(null), schema);
    expect(!result.ok && (await errorOf(result.response))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_json" } },
    });
  });

  it("returns per-field issues for the wrong shape", async () => {
    const result = await parseJsonBody(jsonRequest('{"name":"","extra":1}'), schema);
    expect(!result.ok).toBe(true);
    if (!result.ok) {
      const { status, body } = await errorOf(result.response);
      expect(status).toBe(400);
      expect(body.error.code).toBe("validation_error");
      expect(body.error.issues.map((i: { path: string }) => i.path)).toContain("name");
    }
  });

  it("rejects a body over the limit with 413, even without a Content-Length", async () => {
    // A ReadableStream has no known length, so only the streaming check can catch this.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(2000)));
        controller.close();
      },
    });
    const request = new Request("http://127.0.0.1:4747/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const result = await parseJsonBody(request, schema, 1000);
    expect(!result.ok && result.response.status).toBe(413);
  });

  it("rejects a declared Content-Length over the limit with 413", async () => {
    const result = await parseJsonBody(
      jsonRequest('{"name":"a"}', { "Content-Length": "5000" }),
      schema,
      1000,
    );
    expect(!result.ok && result.response.status).toBe(413);
  });
});
