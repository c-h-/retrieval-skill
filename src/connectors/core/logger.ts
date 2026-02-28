import type { Logger } from "./types.js";

export class ConsoleLogger implements Logger {
  private readonly prefix: string;

  constructor(adapterName: string) {
    this.prefix = `[${adapterName}]`;
  }

  info(msg: string, data?: Record<string, unknown>): void {
    const extra = data ? ` ${JSON.stringify(data)}` : "";
    console.log(`${this.prefix} ${msg}${extra}`);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    const extra = data ? ` ${JSON.stringify(data)}` : "";
    console.warn(`${this.prefix} ⚠ ${msg}${extra}`);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    const extra = data ? ` ${JSON.stringify(data)}` : "";
    console.error(`${this.prefix} ✗ ${msg}${extra}`);
  }

  progress(current: number, total: number, label: string): void {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    process.stdout.write(
      `\r${this.prefix} ${label}: ${current}/${total} (${pct}%)`,
    );
    if (current >= total) process.stdout.write("\n");
  }
}

export function createLogger(adapterName: string): Logger {
  return new ConsoleLogger(adapterName);
}
