import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Extract the secret from `X-Tools-Secret` or `Authorization: Bearer`. */
export function presentedSecret(req: FastifyRequest): string | undefined {
  const header = req.headers["x-tools-secret"];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}

/** Constant-time comparison (hashing first hides the length). */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}
