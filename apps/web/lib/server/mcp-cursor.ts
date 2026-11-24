/**
 * A cursor that Claude can neither read nor make (`docs/mcp-server-plan.md`; the review of 1.11.0). The page reader's cursor is
 * the key of the last row (and the sort value), in plain base64: for a table whose KEY is a hidden column that is a leak of
 * the hidden value, and a cursor Claude writes itself is an ordering oracle on it. So Claude gets a SEALED cursor: AES-256-GCM
 * with a key made for this run and kept in memory, bound to the connection, table and sort it was made for.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CursorSealer {
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  seal(cursor: string, scope: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(scope, "utf8"));
    const body = Buffer.concat([cipher.update(cursor, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  /** The original cursor, or null when this is not one that was sealed here for this scope. */
  open(sealed: string, scope: string): string | null {
    try {
      const raw = Buffer.from(sealed, "base64url");
      if (raw.length < 29) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(scope, "utf8"));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
