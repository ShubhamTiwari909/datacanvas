import { describe, expect, it } from "vitest";
import { exportFileName, sizeText } from "./export-file";

describe("exportFileName", () => {
  const at = new Date(2026, 10, 21, 14, 30, 5);
  it("is the table and the moment, with the extension of the format", () => {
    expect(exportFileName("orders", "csv", at)).toBe("orders-20261121-143005.csv");
    expect(exportFileName("orders", "ndjson", at)).toBe("orders-20261121-143005.ndjson");
  });
  it("reduces a table name to safe characters, and never leaves it empty", () => {
    expect(exportFileName('we"ird/../name é', "json", at)).toBe(
      "we_ird_name_e-20261121-143005.json",
    );
    expect(exportFileName("日本語", "tsv", at)).toBe("table-20261121-143005.tsv");
    expect(exportFileName("a".repeat(200), "csv", at).length).toBeLessThan(90);
  });
});

describe("sizeText", () => {
  it("says bytes, KB and MB", () => {
    expect(sizeText(12)).toBe("12 bytes");
    expect(sizeText(2048)).toBe("2.0 KB");
    expect(sizeText(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
