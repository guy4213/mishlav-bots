// משתמשים (admins only): who may log in to the dashboard - a phone + a password each, role "משלב" or "צוות הפרויקט".
// Add, rename, change role, block / unblock, set a new password. Never deleted: blocking keeps the history. A blocked
// user, a new role or a new password take effect within a minute on every server (apps/backend/src/users.ts).
import { get, post, session } from "../api.js";
import { chip, confirmDialog, emptyState, errorState, esc, fmtDateTime, icon, loadingState, openDrawer, toast } from "../ui.js";

const ROLE_HE = { mishlav: "משלב", admin: "צוות הפרויקט" };
const ROLE_TEXT = {
  mishlav: "רואים: סקירה, שיחות והקלטות, אנשי קשר, משימות לנציגים, ימי עיון (גם עריכה), ושיחת בדיקה למספר שלהם בלבד.",
  admin: "הכול: גם לוגים, הפעלת וכיבוי החיוג, קול הבוט, בדיקות, גולד והמשתמשים.",
};
const localPhone = (p) => String(p ?? "").replace(/^\+972/, "0");

/** 10 characters, no look-alikes (0/O, 1/l/I): easy to read out on the phone. */
function newPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

let users = [];

export default {
  id: "users",
  title: "משתמשים",
  icon: "shield",
  mount(root) {
    root.innerHTML = `
      <div class="toolbar">
        <span class="muted small" id="usCount"></span>
        <span class="spacer"></span>
        <button class="btn primary" id="usNew">${icon("plus")} משתמש חדש</button>
      </div>
      <div class="card" id="usBody">${loadingState(5)}</div>
      <p class="small muted">כל אחד נכנס עם מספר הטלפון שלו וסיסמה. משתמש לא נמחק – חוסמים אותו. חסימה, שינוי הרשאה או סיסמה חדשה תופסים תוך דקה, והחיבורים הפתוחים שלו מתנתקים.</p>`;
    const body = root.querySelector("#usBody");
    const load = async () => {
      try {
        users = (await get("/api/admin/users")).users;
        root.querySelector("#usCount").textContent = `${users.filter((u) => u.active).length} פעילים מתוך ${users.length}`;
        body.innerHTML = table();
      } catch (e) {
        body.innerHTML = /Supabase/.test(e.message) ? emptyState("אין משתמשים בשרת הזה", e.message, "alert") : errorState(e.message);
      }
    };
    root.querySelector("#usNew").onclick = () => openForm(null, load);
    body.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openForm(users.find((u) => u.id === tr.dataset.id), load);
    });
    load();
  },
};

function table() {
  if (!users.length) return emptyState("עוד אין משתמשים", "הוסף את עובדי משלב בכפתור \"משתמש חדש\".", "users");
  return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>שם</th><th>טלפון</th><th>הרשאה</th><th>מצב</th><th>כניסה אחרונה</th>
    </tr></thead><tbody>${users
      .map((u) => `<tr class="click" data-id="${esc(u.id)}">
        <td class="cell-main">${esc(u.name)}${u.id === session.user?.id ? ` <span class="faint small">(אתה)</span>` : ""}</td>
        <td class="ltr num">${esc(localPhone(u.phone))}</td>
        <td>${chip(ROLE_HE[u.role] ?? u.role, u.role === "admin" ? "violet" : "info")}</td>
        <td>${u.active ? chip("פעיל", "success", { dot: true }) : chip("חסום", "danger", { dot: true })}</td>
        <td class="nowrap small">${u.last_login_at ? esc(fmtDateTime(u.last_login_at)) : `<span class="faint">עוד לא נכנס</span>`}</td>
      </tr>`)
      .join("")}</tbody></table></div>`;
}

// ------------------------------------------------------------------ add / edit one user

function openForm(user, reload) {
  const editing = !!user;
  const me = editing && user.id === session.user?.id;
  const dr = openDrawer({ title: editing ? esc(user.name) : "משתמש חדש", sub: editing ? `<span class="ltr">${esc(localPhone(user.phone))}</span>` : "" });
  const role = user?.role ?? "mishlav";
  dr.body.innerHTML = `
    <form id="usForm" class="form-grid" novalidate>
      <label class="field full" data-f="name">שם<input type="text" name="name" value="${esc(user?.name ?? "")}" maxlength="80" required></label>
      <label class="field full" data-f="phone">מספר טלפון (איתו נכנסים, ואליו שיחת הבדיקה)<input type="tel" name="phone" class="ltr" inputmode="tel" value="${esc(localPhone(user?.phone))}" ${editing ? "readonly" : ""} placeholder="0501234567"></label>
      <div class="field full" data-f="role">הרשאה
        <div class="seg" id="usRole">
          <button type="button" data-v="mishlav" class="${role === "mishlav" ? "on" : ""}" ${me ? "disabled" : ""}>משלב</button>
          <button type="button" data-v="admin" class="${role === "admin" ? "on" : ""}">צוות הפרויקט</button>
        </div>
        <span class="small muted" id="usRoleText">${esc(ROLE_TEXT[role])}</span>
      </div>
      ${editing ? "" : `<label class="field full" data-f="password">סיסמה ראשונה (8 תווים לפחות)
        <span class="row"><input type="text" name="password" class="ltr" value="${newPassword()}" autocomplete="off" style="flex:1"><button class="btn sm" type="button" id="usGen">סיסמה אחרת</button></span>
        <span class="small muted">תעביר אותה לעובד. הוא יכול להחליף אותה אחרי הכניסה ("החלפת סיסמה").</span></label>`}
      <div class="full small" id="usError" style="color:var(--danger)" hidden></div>
      <div class="row full" style="margin-top:6px">
        <button class="btn primary" type="submit">${editing ? "שמירה" : "הוספה"}</button>
        <button class="btn ghost" type="button" id="usCancel">ביטול</button>
      </div>
    </form>
    ${editing ? `
      <div class="section-title">פעולות</div>
      <div class="row">
        <button class="btn" id="usReset">סיסמה חדשה</button>
        ${me ? "" : `<button class="btn ${user.active ? "danger" : "success"}" id="usActive">${user.active ? "חסימה" : "ביטול החסימה"}</button>`}
      </div>
      <div class="section-title">פרטים</div>
      <dl class="kv">
        <dt>נוסף</dt><dd>${esc(fmtDateTime(user.created_at))}</dd>
        <dt>כניסה אחרונה</dt><dd>${user.last_login_at ? esc(fmtDateTime(user.last_login_at)) : "עוד לא נכנס"}</dd>
        <dt>סיסמה הוחלפה</dt><dd>${esc(fmtDateTime(user.password_changed_at))}</dd>
      </dl>` : ""}`;

  const form = dr.body.querySelector("#usForm");
  let chosen = role;
  form.querySelector("#usRole").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b || b.disabled) return;
    chosen = b.dataset.v;
    form.querySelectorAll("#usRole button").forEach((x) => x.classList.toggle("on", x === b));
    form.querySelector("#usRoleText").textContent = ROLE_TEXT[chosen];
  });
  form.querySelector("#usGen")?.addEventListener("click", () => (form.elements.namedItem("password").value = newPassword()));
  form.querySelector("#usCancel").onclick = () => dr.close();
  const showError = (e) => {
    const el = form.querySelector("#usError");
    el.textContent = e.message;
    el.hidden = false;
    form.querySelectorAll("[data-f]").forEach((f) => f.classList.toggle("bad", (e.fields ?? []).includes(f.dataset.f)));
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = (n) => form.elements.namedItem(n)?.value.trim() ?? "";
    try {
      if (editing) {
        await post(`/api/admin/users/${user.id}`, { name: val("name"), role: chosen });
        toast("נשמר", "ok");
      } else {
        const password = val("password");
        const r = await post("/api/admin/users", { name: val("name"), phone: val("phone"), role: chosen, password });
        await reload();
        showPassword(r.user, password);
        return;
      }
      await reload();
      dr.close();
    } catch (err) {
      showError(err);
    }
  });

  dr.body.querySelector("#usReset")?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: `סיסמה חדשה ל${user.name}?`,
      text: "הסיסמה הנוכחית תפסיק לעבוד, וכל החיבורים הפתוחים שלו יתנתקו תוך דקה.",
      okLabel: "יצירת סיסמה חדשה",
    });
    if (!ok.ok) return;
    const password = newPassword();
    try {
      await post(`/api/admin/users/${user.id}/password`, { password });
      await reload();
      showPassword(user, password);
    } catch (err) {
      toast(err.message, "bad");
    }
  });

  dr.body.querySelector("#usActive")?.addEventListener("click", async () => {
    if (user.active) {
      const ok = await confirmDialog({
        title: `לחסום את ${user.name}?`,
        text: "לא יוכל להיכנס, והחיבורים הפתוחים שלו יתנתקו תוך דקה. אפשר לבטל את החסימה מתי שרוצים.",
        okLabel: "חסימה",
        danger: true,
      });
      if (!ok.ok) return;
    }
    try {
      await post(`/api/admin/users/${user.id}`, { active: !user.active });
      toast(user.active ? "נחסם" : "החסימה בוטלה", "ok");
      await reload();
      openForm(users.find((u) => u.id === user.id), reload);
    } catch (err) {
      toast(err.message, "bad");
    }
  });
}

/** The password, once: it is not kept anywhere readable. */
function showPassword(user, password) {
  const dr = openDrawer({ title: `הסיסמה של ${esc(user.name)}`, sub: `<span class="ltr">${esc(localPhone(user.phone))}</span>` });
  dr.body.innerHTML = `
    <div class="banner ok" style="display:block">
      <div>כניסה עם <b class="ltr">${esc(localPhone(user.phone))}</b> והסיסמה:</div>
      <div class="ltr" style="font-size:1.4em;font-weight:600;letter-spacing:.05em;margin:10px 0">${esc(password)}</div>
      <button class="btn sm" id="usCopy">העתקה</button>
    </div>
    <p class="small muted">הסיסמה מוצגת עכשיו בלבד – היא לא נשמרת בשום מקום שאפשר לקרוא. אם תאבד: "סיסמה חדשה".</p>`;
  dr.body.querySelector("#usCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast("הועתק", "ok");
    } catch {
      toast("לא הצלחתי להעתיק – סמן והעתק ידנית", "bad");
    }
  };
}
