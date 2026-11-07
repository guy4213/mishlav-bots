import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only JSON-lines file. Sync writes keep lines ordered and intact. */
export class JsonlFile {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(record: object): void {
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
  }

  readAll(): unknown[] {
    return readJsonl(this.path);
  }
}

export function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${path}:${i + 1}: invalid JSON line`);
      }
    });
}
