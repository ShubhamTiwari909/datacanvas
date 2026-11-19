import { describe, expect, it } from "vitest";
import {
  checkFileSize,
  checkFileText,
  MAX_SQL_FILE_BYTES,
  normalizeText,
  sqlFileName,
  tabNameFromFile,
} from "./files";

describe("sqlFileName", () => {
  it("adds .sql and keeps an ordinary name", () => {
    expect(sqlFileName("Query 1")).toBe("Query 1.sql");
    expect(sqlFileName("Orders check (copy)")).toBe("Orders check (copy).sql");
  });

  it("removes what a file name cannot hold, and falls back to a name", () => {
    expect(sqlFileName("a/b\\c:d*e?f")).toBe("a_b_c_d_e_f.sql");
    expect(sqlFileName("../../etc/passwd")).toBe("_.._etc_passwd.sql");
    expect(sqlFileName("   ")).toBe("query.sql");
    expect(sqlFileName("...")).toBe("query.sql");
    expect(sqlFileName("line\nbreak")).toBe("line_break.sql");
  });

  it("never yields a path", () => {
    for (const name of ["../x", "/abs", "C:\\win", "a/../b"]) {
      expect(sqlFileName(name)).not.toMatch(/[\\/]/);
      expect(sqlFileName(name).startsWith(".")).toBe(false);
    }
  });
});

describe("tabNameFromFile", () => {
  it("drops the folder and a known extension", () => {
    expect(tabNameFromFile("from-disk.sql")).toBe("from-disk");
    expect(tabNameFromFile("C:\\work\\report.SQL")).toBe("report");
    expect(tabNameFromFile("/tmp/notes.txt")).toBe("notes");
    expect(tabNameFromFile("data.csv")).toBe("data.csv");
    expect(tabNameFromFile(".sql")).toBe("Opened file");
  });
});

describe("normalizeText", () => {
  it("uses line feeds and drops a byte order mark", () => {
    expect(normalizeText("\uFEFFSELECT 1\r\nFROM x\rWHERE y")).toBe("SELECT 1\nFROM x\nWHERE y");
  });
});

describe("the checks", () => {
  it("refuses a big file before reading it", () => {
    expect(checkFileSize(MAX_SQL_FILE_BYTES).ok).toBe(true);
    expect(checkFileSize(MAX_SQL_FILE_BYTES + 1)).toMatchObject({ ok: false });
  });

  it("refuses binary and too long text", () => {
    expect(checkFileText("SELECT 1").ok).toBe(true);
    expect(checkFileText("SELECT '\u0000'")).toMatchObject({
      ok: false,
      message: expect.stringContaining("not text"),
    });
    expect(checkFileText("x".repeat(200_001))).toMatchObject({
      ok: false,
      message: expect.stringContaining("200,000"),
    });
  });
});
