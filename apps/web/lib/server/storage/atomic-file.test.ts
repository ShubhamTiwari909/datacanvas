import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDataDir } from "../test-support";
import { KeyedMutex, ensureDirectory, readTextFile, writeFileAtomic } from "./atomic-file";

describe("writeFileAtomic", () => {
  it("creates the file (and missing folders) with the content", async () => {
    const file = path.join(createTestDataDir(), "a", "b", "data.json");
    await writeFileAtomic(file, '{"x":1}');
    expect(await readTextFile(file)).toBe('{"x":1}');
  });

  it("replaces an existing file completely", async () => {
    const file = path.join(createTestDataDir(), "data.json");
    await writeFileAtomic(file, "a long first version of the content");
    await writeFileAtomic(file, "short");
    expect(await readTextFile(file)).toBe("short");
  });

  it("leaves no temporary files behind", async () => {
    const dir = createTestDataDir();
    for (let i = 0; i < 5; i += 1) await writeFileAtomic(path.join(dir, "data.json"), `v${i}`);
    expect(await fs.readdir(dir)).toEqual(["data.json"]);
  });

  it("cleans up its temporary file and keeps the old content when the write fails", async () => {
    const dir = createTestDataDir();
    const target = path.join(dir, "data.json");
    await writeFileAtomic(target, "original");

    // A directory where the file should go makes the final rename fail.
    const blocked = path.join(dir, "blocked.json");
    await fs.mkdir(blocked);
    await expect(writeFileAtomic(blocked, "new")).rejects.toThrow();

    expect((await fs.readdir(dir)).sort()).toEqual(["blocked.json", "data.json"]); // no stray .tmp
    expect(await readTextFile(target)).toBe("original");
  });

  it.skipIf(process.platform === "win32")(
    "creates private files and folders (owner only)",
    async () => {
      const root = createTestDataDir();
      const file = path.join(root, "private", "data.json");
      await writeFileAtomic(file, "{}");
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    },
  );

  it("never exposes a half-written file to a reader, even with many writers at once", async () => {
    const file = path.join(createTestDataDir(), "data.json");
    const contents = Array.from({ length: 40 }, (_v, i) =>
      JSON.stringify({ n: i, pad: "x".repeat(20_000) }),
    );
    await writeFileAtomic(file, contents[0] as string);

    let reading = true;
    const bad: string[] = [];
    const reader = (async () => {
      while (reading) {
        const text = await readTextFile(file);
        try {
          JSON.parse(text as string);
        } catch {
          bad.push((text ?? "").slice(0, 30));
        }
      }
    })();
    await Promise.all(contents.map((content) => writeFileAtomic(file, content)));
    reading = false;
    await reader;

    expect(bad).toEqual([]); // every read saw a complete document
    expect(contents).toContain(await readTextFile(file)); // and the final file is one writer's content, intact
  });
});

describe("readTextFile", () => {
  it("returns null for a missing file", async () => {
    expect(await readTextFile(path.join(createTestDataDir(), "nope.json"))).toBeNull();
  });
});

describe("ensureDirectory", () => {
  it("is safe to call twice", async () => {
    const dir = path.join(createTestDataDir(), "x");
    await ensureDirectory(dir);
    await ensureDirectory(dir);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });
});

describe("KeyedMutex", () => {
  it("runs jobs with the same key one at a time, in order", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const job = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`end ${name}`);
    };
    await Promise.all([
      mutex.run("k", job("a", 30)),
      mutex.run("k", job("b", 1)),
      mutex.run("k", job("c", 1)),
    ]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("runs jobs with different keys in parallel", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    await Promise.all([
      mutex.run("one", async () => {
        events.push("start one");
        await new Promise((r) => setTimeout(r, 20));
        events.push("end one");
      }),
      mutex.run("two", async () => {
        events.push("start two");
      }),
    ]);
    expect(events.indexOf("start two")).toBeLessThan(events.indexOf("end one"));
  });

  it("keeps the queue going after a failed job, and reports the failure to its caller", async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run("k", async () => {
      throw new Error("boom");
    });
    const next = mutex.run("k", async () => "still works");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("still works");
  });

  it("prevents lost updates in a read-modify-write cycle", async () => {
    const mutex = new KeyedMutex();
    let value = 0;
    const increment = () =>
      mutex.run("counter", async () => {
        const read = value;
        await new Promise((r) => setTimeout(r, 1));
        value = read + 1;
      });
    await Promise.all(Array.from({ length: 25 }, increment));
    expect(value).toBe(25);
  });
});
