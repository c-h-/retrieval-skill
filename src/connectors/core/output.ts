import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { OutputWriter } from "./types.js";

export class FileOutputWriter implements OutputWriter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private resolve(relativePath: string): string {
    return path.join(this.baseDir, relativePath);
  }

  private ensureDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  private atomicWrite(filePath: string, content: string | Buffer): void {
    this.ensureDir(filePath);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  }

  async writeDocument(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const filePath = this.resolve(relativePath);
    const fm = yamlStringify(frontmatter).trim();
    const content = `---\n${fm}\n---\n\n${body}`;
    this.atomicWrite(filePath, content);
  }

  async writeMeta(
    relativePath: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const filePath = this.resolve(relativePath);
    this.atomicWrite(filePath, JSON.stringify(data, null, 2));
  }

  async writeJsonl(
    relativePath: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    const filePath = this.resolve(relativePath);
    const lines = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
    this.atomicWrite(filePath, lines);
  }

  async appendJsonl(
    relativePath: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    const filePath = this.resolve(relativePath);
    this.ensureDir(filePath);
    const lines = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
    fs.appendFileSync(filePath, lines);
  }

  async writeBinary(relativePath: string, data: Buffer): Promise<void> {
    const filePath = this.resolve(relativePath);
    this.atomicWrite(filePath, data);
  }

  async remove(relativePath: string): Promise<void> {
    const filePath = this.resolve(relativePath);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File doesn't exist, that's fine
    }
  }
}

export function createOutputWriter(baseDir: string): OutputWriter {
  return new FileOutputWriter(baseDir);
}
