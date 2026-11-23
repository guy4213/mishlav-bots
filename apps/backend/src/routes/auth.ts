/**
 * Logging in to the dashboard and managing who can (users.ts, access.ts).
 *
 *   POST /auth/login     {phone, password} -> sets the session cookie; { ok, user }     (public)
 *   POST /auth/logout    -> clears it                                                  (public)
 *   GET  /auth/me        -> { ok, role, via: "secret" | "session", user | null, viewing_as }
 *                           (viewing_as: an admin seeing the dashboard as Mishlav does, header x-view-as: access.ts)
 *                           + server {version, started_at, commit}: admins only
 *   POST /auth/password  {current, password} -> the logged-in user's own password (other sessions end; a new cookie)
 *
 *   GET  /api/admin/users                  -> every user (no hashes)                     (admin)
 *   POST /api/admin/users                  {name, phone, role, password} -> 409 user_exists
 *   POST /api/admin/users/:id              {name?, role?, active?}
 *   POST /api/admin/users/:id/password     {password} -> a new password (their sessions end)
 * Without Supabase: login and users answer 409 no_users (TOOLS_SECRET still works).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Principal } from "../access";
import type { ServerVersion } from "../server";
import { toE164 } from "../contacts";
import {
  hashPassword, LoginLimiter, PASSWORD_MIN, publicUser, ROLES, setSessionCookie, UserExists, type Users, verifyPassword,
} from "../users";

export interface AuthRouteDeps {
  /** none without Supabase */
  users?: Users;
  now?: () => Date;
  /** the dashboard's log: logins, failed logins, user changes */
  log?: (text: string) => void;
  /** which version runs (shown to admins only) */
  server?: ServerVersion;
}

const Password = z.string().min(PASSWORD_MIN).max(200);
const Login = z.strictObject({ phone: z.string().trim().min(6).max(30), password: z.string().min(1).max(200) });
const OwnPassword = z.strictObject({ current: z.string().min(1).max(200), password: Password });
const NewUser = z.strictObject({ name: z.string().trim().min(1).max(80), phone: z.string().trim().min(6).max(30), role: z.enum(ROLES), password: Password });
const EditUser = z.strictObject({ name: z.string().trim().min(1).max(80).optional(), role: z.enum(ROLES).optional(), active: z.boolean().optional() });
const ResetPassword = z.strictObject({ password: Password });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PASSWORD_HE = `סיסמה של ${PASSWORD_MIN} תווים לפחות`;
const NO_USERS = { ok: false, error: "no_users", message_he: "אין משתמשים בשרת הזה (Supabase לא מחובר). אפשר להיכנס עם סיסמת השרת." };
const masked = (phone: string) => phone.replace(/^(\+?\d{5})\d+(\d{4})$/, "$1***$2");

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const users = deps.users;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  // 5 wrong passwords per phone; 20 per address (a whole office behind one address shouldn't lock itself out)
  const byPhone = new LoginLimiter(now, 5);
  const byIp = new LoginLimiter(now, 20);
  const bad = (reply: FastifyReply, message_he: string, fields: string[] = []) =>
    reply.code(400).send({ ok: false, error: "invalid_params", message_he, fields });
  const supabaseError = (reply: FastifyReply, err: unknown) =>
    reply.code(502).send({ ok: false, error: "supabase_error", message_he: (err as Error).message });

  app.post("/auth/login", async (req, reply) => {
    if (!users) return reply.code(409).send(NO_USERS);
    const parsed = Login.safeParse(req.body ?? {});
    const phone = parsed.success ? toE164(parsed.data.phone) : null;
    if (!parsed.success || !phone) return bad(reply, "הכנס מספר טלפון וסיסמה");
    const wait = Math.max(byPhone.waitSeconds([phone]), byIp.waitSeconds([req.ip]));
    if (wait) {
      return reply.code(429).send({ ok: false, error: "too_many_attempts", message_he: `יותר מדי ניסיונות. נסה שוב בעוד ${Math.ceil(wait / 60)} דקות.` });
    }
    let user;
    try {
      user = await users.check(phone, parsed.data.password);
    } catch (err) {
      return supabaseError(reply, err);
    }
    if (!user) {
      byPhone.fail([phone]);
      byIp.fail([req.ip]);
      log(`🔒 failed login for ${masked(phone)} from ${req.ip}`);
      return reply.code(401).send({ ok: false, error: "wrong_login", message_he: "מספר הטלפון או הסיסמה שגויים" });
    }
    byPhone.clear(phone);
    setSessionCookie(req, reply, users.token(user));
    users.store.updateDashboardUser(user.id, { last_login_at: now().toISOString() }).catch(() => {}); // best effort
    log(`🔓 ${user.name} (${user.role}) logged in`);
    return { ok: true, user: publicUser(user) };
  });

  app.post("/auth/logout", async (req, reply) => {
    setSessionCookie(req, reply, null);
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const p = req.principal as Principal;
    // the version is for us: not for Mishlav's users (nor for an admin viewing as them)
    return { ok: true, role: p.role, via: p.via, user: p.user, viewing_as: !!p.viewingAs, ...(p.role === "admin" && deps.server && { server: deps.server }) };
  });

  app.post("/auth/password", async (req, reply) => {
    const p = req.principal as Principal;
    if (!users || !p.user) return reply.code(409).send({ ok: false, error: "not_a_user", message_he: "רק משתמש מחובר יכול להחליף סיסמה" });
    const parsed = OwnPassword.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, PASSWORD_HE, ["password"]);
    try {
      const me = (await users.list()).find((u) => u.id === p.user!.id);
      if (!me || !(await verifyPassword(parsed.data.current, me.password_hash))) {
        return reply.code(400).send({ ok: false, error: "wrong_password", message_he: "הסיסמה הנוכחית שגויה", fields: ["current"] });
      }
      const updated = await users.store.updateDashboardUser(me.id, {
        password_hash: await hashPassword(parsed.data.password),
        password_changed_at: now().toISOString(),
      });
      await users.refresh();
      if (updated) setSessionCookie(req, reply, users.token(updated)); // this browser stays in, the others are out
      log(`🔑 ${me.name} changed their password`);
      return { ok: true };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  // ---- managing the users (admins only: access.ts)
  app.get("/api/admin/users", async (_req, reply) => {
    if (!users) return reply.code(409).send(NO_USERS);
    try {
      return { ok: true, users: (await users.list()).map(publicUser) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  app.post("/api/admin/users", async (req, reply) => {
    if (!users) return reply.code(409).send(NO_USERS);
    const parsed = NewUser.safeParse(req.body ?? {});
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
      return bad(reply, fields.includes("password") ? PASSWORD_HE : "לא תקין: " + fields.map((f) => FIELD_HE[f] ?? f).join(", "), fields);
    }
    const phone = toE164(parsed.data.phone);
    if (!phone) return bad(reply, "מספר טלפון לא תקין", ["phone"]);
    try {
      const user = await users.store.createDashboardUser({
        phone,
        name: parsed.data.name,
        role: parsed.data.role,
        password_hash: await hashPassword(parsed.data.password),
      });
      await users.refresh();
      log(`👤 user added: ${user.name} (${user.role}) by ${who(req.principal)}`);
      return { ok: true, user: publicUser(user) };
    } catch (err) {
      if (err instanceof UserExists) return reply.code(409).send({ ok: false, error: "user_exists", message_he: "כבר יש משתמש עם המספר הזה", fields: ["phone"] });
      return supabaseError(reply, err);
    }
  });

  app.post("/api/admin/users/:id", async (req, reply) => {
    if (!users) return reply.code(409).send(NO_USERS);
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ ok: false, error: "invalid_id" });
    const parsed = EditUser.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, "לא תקין");
    // an admin can't lock themselves out by mistake
    if (req.principal?.user?.id === id && (parsed.data.active === false || parsed.data.role === "mishlav")) {
      return reply.code(409).send({ ok: false, error: "self", message_he: "אי אפשר לחסום את עצמך או להוריד לעצמך הרשאות" });
    }
    try {
      const user = await users.store.updateDashboardUser(id, parsed.data);
      if (!user) return reply.code(404).send({ ok: false, error: "unknown_user", message_he: "אין משתמש כזה" });
      await users.refresh();
      log(`👤 user changed: ${user.name} ${JSON.stringify(parsed.data)} by ${who(req.principal)}`);
      return { ok: true, user: publicUser(user) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });

  app.post("/api/admin/users/:id/password", async (req, reply) => {
    if (!users) return reply.code(409).send(NO_USERS);
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ ok: false, error: "invalid_id" });
    const parsed = ResetPassword.safeParse(req.body ?? {});
    if (!parsed.success) return bad(reply, PASSWORD_HE, ["password"]);
    try {
      const user = await users.store.updateDashboardUser(id, {
        password_hash: await hashPassword(parsed.data.password),
        password_changed_at: now().toISOString(),
      });
      if (!user) return reply.code(404).send({ ok: false, error: "unknown_user", message_he: "אין משתמש כזה" });
      await users.refresh();
      log(`🔑 password reset for ${user.name} by ${who(req.principal)}`);
      return { ok: true, user: publicUser(user) };
    } catch (err) {
      return supabaseError(reply, err);
    }
  });
}

const FIELD_HE: Record<string, string> = { name: "שם", phone: "טלפון", role: "הרשאה", password: "סיסמה" };
const who = (p: Principal | null) => p?.user?.name ?? "TOOLS_SECRET";
