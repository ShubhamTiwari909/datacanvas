import { describe, expect, it } from "vitest";
import { buildScripts, commentOut, flattenComment, resolveSelection, summarize } from "./script.js";
import type { MigrationPlan, MigrationStep } from "./types.js";

const step = (id: string, extra: Partial<MigrationStep> = {}): MigrationStep => ({
  id,
  kind: "create_table",
  object: { schema: "public", table: id },
  up: `CREATE TABLE ${id} ();`,
  down: `DROP TABLE ${id};`,
  risk: [],
  reversibility: "full",
  transactional: true,
  dependsOn: [],
  note: `Does ${id}.`,
  ...extra,
});
const planOf = (steps: MigrationStep[]): MigrationPlan => ({
  steps,
  reversibility: "full",
  notCompared: [],
  warnings: [],
});
const none = { leftOut: new Set<string>(), confirmed: new Set<string>() };

describe("comments", () => {
  it("flattens every kind of line break, carriage return included", () => {
    expect(flattenComment("a\nb\rc\r\nd\u2028e")).toBe("a b c d e");
  });
  it("comments out SQL cut at every line break, so no part of it can run", () => {
    const text = commentOut("DROP TABLE a;\rDROP TABLE b;\r\nDROP TABLE c;\nDROP TABLE d;");
    expect(text.split(/\r\n|\r|\n/).every((line) => line.startsWith("-- "))).toBe(true);
    expect(text).not.toMatch(/[\r]/);
  });
});

describe("leaving a change out", () => {
  const plan = planOf([
    step("s1"),
    step("s2", { dependsOn: ["s1"] }),
    step("s3", { dependsOn: ["s2"] }),
    step("s4"),
  ]);
  it("takes what depends on it along, and says why", () => {
    const { included, keptTogether } = resolveSelection(plan, new Set(["s1"]));
    expect(included.map((s) => s.id)).toEqual(["s4"]);
    expect(keptTogether.get("s2")).toBe("s1");
    expect(keptTogether.get("s3")).toBe("s1");
  });
  it("leaves the rest alone", () => {
    expect(resolveSelection(plan, new Set(["s4"])).included.map((s) => s.id)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });
});

describe("the scripts", () => {
  const destructive = step("s2", {
    kind: "drop_table",
    up: "DROP TABLE x;",
    down: "CREATE TABLE x ();",
    risk: ["destructive"],
    reversibility: "data_lost",
  });
  const plan = planOf([step("s1"), destructive, step("s3", { down: null, reversibility: "none" })]);

  it("writes an unconfirmed destructive step commented out, in both scripts", () => {
    const { up, down, held } = buildScripts(plan, none);
    expect(held).toEqual(["s2"]);
    expect(up).toContain("-- DROP TABLE x;");
    expect(up).not.toMatch(/^DROP TABLE x;/m);
    expect(down).toContain("-- CREATE TABLE x ();");
    expect(down).not.toMatch(/^CREATE TABLE x \(\);/m);
  });
  it("writes it as SQL once confirmed", () => {
    const { up, held } = buildScripts(plan, { leftOut: new Set(), confirmed: new Set(["s2"]) });
    expect(held).toEqual([]);
    expect(up).toMatch(/^DROP TABLE x;/m);
  });
  it("runs the rollback in reverse and says what cannot be undone", () => {
    const { down } = buildScripts(plan, { leftOut: new Set(), confirmed: new Set(["s2"]) });
    expect(down.indexOf("undo s3")).toBeLessThan(down.indexOf("undo s1"));
    expect(down).toContain("This step cannot be undone.");
  });
  it("keeps a hostile note on one line", () => {
    const hostile = planOf([step("s1", { note: "evil\nDROP TABLE users;\r-- " })]);
    const { up } = buildScripts(hostile, none);
    expect(up.split(/\r\n|\r|\n/).filter((l) => l.startsWith("DROP TABLE users"))).toEqual([]);
  });
});

describe("the summary", () => {
  it("counts by risk and gives the verdict of what is in", () => {
    const plan = planOf([
      step("s1", { risk: ["lock", "may_fail"] }),
      step("s2", { risk: ["destructive"], reversibility: "data_lost" }),
    ]);
    const all = summarize(plan, none);
    expect(all).toMatchObject({
      steps: 2,
      destructive: 1,
      unconfirmed: 1,
      reversibility: "partial",
    });
    expect(all.byRisk).toMatchObject({ lock: 1, may_fail: 1, rewrite: 0 });
    expect(summarize(plan, { ...none, leftOut: new Set(["s2"]) }).reversibility).toBe("full");
  });
});
