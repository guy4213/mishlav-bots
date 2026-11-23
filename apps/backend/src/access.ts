/**
 * Who may call what. TOOLS_SECRET and admin users: everything. Mishlav's users: only the routes listed here, so a
 * route added later is closed to them until someone opens it on purpose.
 *
 * Open to Mishlav: what happened (summary, calls + recordings + transcripts, contacts, rep tasks, the dialer's state),
 * the study days (they edit them), and a test call to their own phone (routes/phone.ts /api/me/*).
 * Closed: the server's logs, the dialer switch, the bot's voice, the Gold feed, test tooling (scenarios, scores,
 * dialing any number or a contact), the bot's tool endpoints and the users.
 */
import type { PublicUser, Role } from "./users";

export interface Principal {
  role: Role;
  via: "secret" | "session";
  /** the logged-in person (via a session); null with TOOLS_SECRET */
  user: PublicUser | null;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const SEG = "[^/]+";
const MISHLAV: [method: string, path: RegExp][] = [
  ["GET", /^\/auth\/me$/],
  ["POST", /^\/auth\/password$/],
  ["GET", /^\/api\/admin\/summary$/],
  ["GET", /^\/api\/admin\/dialer$/], // its state; start / stop stay ours
  ["GET", new RegExp(`^/api/admin/contacts(/${SEG})?$`)],
  ["GET", new RegExp(`^/api/admin/calls(/${SEG}(/recording)?)?$`)],
  ["GET", /^\/api\/admin\/rep-tasks$/],
  ["POST", new RegExp(`^/api/admin/rep-tasks/${SEG}/done$`)],
  ["GET", /^\/api\/admin\/study-days$/],
  ["POST", new RegExp(`^/api/admin/study-days(/${SEG}(/(archive|restore))?)?$`)],
  ["GET", /^\/test\/phone$/], // the line's state for the top bar (its log is left out for them: routes/phone.ts)
  ["GET", /^\/api\/me\/test-call$/],
  ["POST", /^\/api\/me\/test-call$/],
  ["POST", /^\/api\/me\/hangup$/],
];

export function mayCall(role: Role, method: string, path: string): boolean {
  if (role === "admin") return true;
  return MISHLAV.some(([m, re]) => m === method && re.test(path));
}

export const isAdmin = (p: Principal | null | undefined) => p?.role === "admin";
