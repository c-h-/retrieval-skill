import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileOutputWriter } from "../../../src/connectors/core/output.js";

describe("FileOutputWriter", () => {
  let tmpDir: string;
  let writer: FileOutputWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saas-mirror-out-"));
    writer = new FileOutputWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes markdown document with frontmatter", async () => {
    await writer.writeDocument(
      "test/page.md",
      { title: "Hello", tags: ["a", "b"] },
      "# Hello\n\nBody text here.",
    );

    const content = fs.readFileSync(path.join(tmpDir, "test/page.md"), "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("title: Hello");
    expect(content).toContain("# Hello");
    expect(content).toContain("Body text here.");
  });

  it("writes JSON metadata", async () => {
    await writer.writeMeta("meta/info.json", { id: "123", count: 5 });

    const raw = fs.readFileSync(path.join(tmpDir, "meta/info.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.id).toBe("123");
    expect(data.count).toBe(5);
  });

  it("writes JSONL", async () => {
    await writer.writeJsonl("data.jsonl", [{ a: 1 }, { b: 2 }]);

    const content = fs.readFileSync(path.join(tmpDir, "data.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[1])).toEqual({ b: 2 });
  });

  it("appends JSONL", async () => {
    await writer.writeJsonl("append.jsonl", [{ a: 1 }]);
    await writer.appendJsonl("append.jsonl", [{ b: 2 }]);

    const content = fs.readFileSync(path.join(tmpDir, "append.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("writes binary data", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writer.writeBinary("files/image.png", buf);

    const data = fs.readFileSync(path.join(tmpDir, "files/image.png"));
    expect(data).toEqual(buf);
  });

  it("removes files", async () => {
    await writer.writeMeta("to-delete.json", { x: 1 });
    expect(fs.existsSync(path.join(tmpDir, "to-delete.json"))).toBe(true);

    await writer.remove("to-delete.json");
    expect(fs.existsSync(path.join(tmpDir, "to-delete.json"))).toBe(false);
  });

  it("remove is idempotent for missing files", async () => {
    await expect(writer.remove("nonexistent.txt")).resolves.toBeUndefined();
  });

  it("creates nested directories automatically", async () => {
    await writer.writeMeta("a/b/c/d/deep.json", { deep: true });
    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "a/b/c/d/deep.json"), "utf-8"),
    );
    expect(data.deep).toBe(true);
  });
});
