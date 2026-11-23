/**
 * Dashboard logins: a phone number + a password per person (Supabase dashboard_users), two roles:
 *   admin   - us: everything (like TOOLS_SECRET, which keeps working for the bot, the worker, scripts and `npm run lab`)
 *   mishlav - Mishlav's people: what access.ts allows
 *
 * A login sets an HttpOnly cookie holding a signed token (user id, password version, expiry), no session table. Every
 * request checks the token against the users as last read from Supabase (kept 30 s): a blocked user, a changed role
 * or a reset password take effect within that time on every server (local / Render), without a database read per
 * request. Passwords are kept as scrypt hashes only.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const ROLES = ["admin", "mishlav"] as const;
export type Role = (typeof ROLES)[number];

export interface DashboardUser {
  id: string;
  phone: string; // E.164
  name: string;
  role: Role;
  password_hash: string;
  active: boolean;
  password_changed_at: string;
  last_login_at: string | null;
  created_at: string;
}

/** A user as the dashboard sees it: never the hash. */
export type PublicUser = Omit<DashboardUser, "password_hash">;
export const publicUser = ({ password_hash: _h, ...u }: DashboardUser): PublicUser => u;

export interface UserStore {
  dashboardUsers(): Promise<DashboardUser[]>;
  createDashboardUser(row: Pick<DashboardUser, "phone" | "name" | "role" | "password_hash">): Promise<DashboardUser>;
  updateDashboardUser(
    id: string,
    patch: Partial<Pick<DashboardUser, "name" | "role" | "active" | "password_hash" | "password_changed_at" | "last_login_at">>,
  ): Promise<DashboardUser | null>;
}

export class UserExists extends Error {
  constructor(phone: string) {
    super(`a user with phone ${phone} already exists`);
  }
}

// ------------------------------------------------------------------ passwords

export const PASSWORD_MIN = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const got = await scrypt(password, Buffer.from(salt, "base64url"), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// a hash to check against when the phone is unknown, so a wrong phone takes as long as a wrong password
const DUMMY_HASH = hashPassword("not-a-password-" + randomBytes(8).toString("hex"));

// ------------------------------------------------------------------ the session cookie

export const COOKIE = "mishlav_session";
export const SESSION_HOURS = 12;

const pwVersion = (u: DashboardUser) => String(Date.parse(u.password_changed_at));

export function readCookie(req: FastifyRequest, name = COOKIE): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string | null) {
  const secure = req.protocol === "https" ? "; Secure" : ""; // Render: https behind its proxy (trustProxy)
  const value = token ? `${encodeURIComponent(token)}; Max-Age=${SESSION_HOURS * 3600}` : "; Max-Age=0";
  reply.header("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

// ------------------------------------------------------------------ the users, as last read

export class Users {
  private byId = new Map<string, DashboardUser>();
  private readAt = 0;
  private loading: Promise<void> | null = null;
  private readonly key: Buffer;

  constructor(
    readonly store: UserStore,
    /** signs the session tokens; derived from TOOLS_SECRET (changing it logs everyone out) */
    secret: string,
    private readonly now: () => Date = () => new Date(),
    private readonly maxAgeMs = 30_000,
  ) {
    this.key = createHmac("sha256", "mishlav-dashboard-session").update(secret).digest();
  }

  /** Read the users again (after each change here; otherwise when older than maxAgeMs). A failure keeps the last read. */
  async refresh(): Promise<void> {
    this.loading ??= this.store
      .dashboardUsers()
      .then((rows) => {
        this.byId = new Map(rows.map((u) => [u.id, u]));
        this.readAt = Date.now();
      })
      .finally(() => (this.loading = null));
    return this.loading;
  }

  private async fresh(): Promise<void> {
    if (Date.now() - this.readAt < this.maxAgeMs) return;
    try {
      await this.refresh();
    } catch (err) {
      if (!this.readAt) throw err; // never read: nobody can be checked
    }
  }

  async list(): Promise<DashboardUser[]> {
    await this.refresh();
    return [...this.byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** The active user with this phone and password, or null (same time either way). */
  async check(phone: string, password: string): Promise<DashboardUser | null> {
    await this.refresh(); // a login reads the table: a user created a second ago on another server can log in
    const user = [...this.byId.values()].find((u) => u.phone === phone);
    const ok = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
    return ok && user?.active ? user : null;
  }

  token(user: DashboardUser): string {
    const exp = this.now().getTime() + SESSION_HOURS * 3600_000;
    const body = `${user.id}.${pwVersion(user)}.${exp}`;
    return `${body}.${this.sign(body)}`;
  }

  /** The cookie's user: signed by us, not expired, still active, password not changed since. */
  async fromRequest(req: FastifyRequest): Promise<DashboardUser | null> {
    const token = readCookie(req);
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [id, version, exp, sig] = parts as [string, string, string, string];
    const expected = Buffer.from(this.sign(`${id}.${version}.${exp}`));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (!(Number(exp) > this.now().getTime())) return null;
    await this.fresh();
    const user = this.byId.get(id);
    return user?.active && pwVersion(user) === version ? user : null;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

// ------------------------------------------------------------------ too many wrong passwords

/** `max` wrong passwords in 15 minutes for a key (a phone, an address): wait until the oldest one is 15 minutes old. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** Seconds to wait before trying again (0: may try). */
  waitSeconds(keys: string[]): number {
    const t = this.now().getTime();
    let wait = 0;
    for (const k of keys) {
      const recent = (this.fails.get(k) ?? []).filter((x) => t - x < this.windowMs);
      this.fails.set(k, recent);
      if (recent.length >= this.max) wait = Math.max(wait, Math.ceil((recent[0]! + this.windowMs - t) / 1000));
    }
    return wait;
  }

  fail(keys: string[]) {
    const t = this.now().getTime();
    for (const k of keys) this.fails.set(k, [...(this.fails.get(k) ?? []), t]);
  }

  clear(key: string) {
    this.fails.delete(key);
  }
}
