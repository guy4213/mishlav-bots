/**
 * The small pieces every screen uses (ports of ui.js's HTML helpers): chips, states, the pager, a phone link, Gold's
 * notes, key-value lists. Same classes and the same DOM, so styles.css draws them as before.
 */
import { Fragment, type ReactNode } from "react";
import { callName } from "../lib/format";
import { CONTACT_STATUS_HE, ORIGIN_HE, OUTCOME_TONE, outcomeLabel, statusTone } from "../lib/labels";
import { telHref } from "../lib/safe-url";
import { Icon } from "./Icon";

export function Chip({ label, tone = "muted", dot = false, cls = "" }: { label: ReactNode; tone?: string; dot?: boolean; cls?: string }) {
  return <span className={`chip t-${tone}${dot ? " dot" : ""}${cls ? ` ${cls}` : ""}`}>{label}</span>;
}

export const StatusChip = ({ s }: { s: string | null | undefined }) => (
  <Chip label={CONTACT_STATUS_HE[s ?? ""] ?? s ?? "—"} tone={statusTone(s)} dot cls={s === "in_call" ? "pulse" : ""} />
);
export const OutcomeChip = ({ o }: { o: string | null | undefined }) => (
  <Chip label={outcomeLabel(o)} tone={OUTCOME_TONE[o ?? "NO_RESULT"] ?? "muted"} />
);
export const OriginChip = ({ o }: { o: string | null | undefined }) => (
  <Chip label={ORIGIN_HE[o ?? ""] ?? o ?? "—"} tone={o === "dialer" ? "info" : "outline"} />
);
/** Where a call came from: the dialer, a dashboard test, or someone calling the line. */
export const CallOriginChip = ({ c }: { c: { direction?: string; origin?: string } | null | undefined }) =>
  c?.direction === "in" ? <Chip label="📞 נכנסת" tone="outline" /> : <OriginChip o={c?.origin} />;

export { callName };

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card-body stack" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, text = "", icon = "inbox", compact = false }: { title: string; text?: ReactNode; icon?: string; compact?: boolean }) {
  return (
    <div className={`state${compact ? " compact" : ""}`}>
      <div className="state-icon">
        <Icon name={icon} />
      </div>
      <div className="state-title">{title}</div>
      {text ? <div className="state-text">{text}</div> : null}
    </div>
  );
}

export function ErrorState({ msg, compact = false }: { msg: string; compact?: boolean }) {
  return (
    <div className={`state error${compact ? " compact" : ""}`}>
      <div className="state-icon">
        <Icon name="alert" />
      </div>
      <div className="state-title">לא הצלחתי לטעון</div>
      <div className="state-text">{msg}</div>
    </div>
  );
}

/** A phone as written, left-to-right, with a tel: link (digits and + only). */
export function PhoneLink({ p }: { p: string | null | undefined }) {
  if (!p) return <>—</>;
  const href = telHref(p);
  return href ? (
    <a className="ltr num" href={href}>
      {p}
    </a>
  ) : (
    <span className="ltr num">{p}</span>
  );
}

/** Gold notes: the bot's "[הערת הבוט]" (older: "[BOT]") lines highlighted. */
export function Notes({ text }: { text: string | null | undefined }) {
  if (!text) return <span className="faint">—</span>;
  const lines = String(text).split(/\r?\n/);
  return (
    <div className="notes">
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 ? "\n" : null}
          {/^\s*\[(הערת הבוט|BOT)\]/.test(l) ? <span className="botnote">{l}</span> : l}
        </Fragment>
      ))}
    </div>
  );
}

/** A key-value list; pairs with an empty value are left out. */
export function Kv({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {pairs
        .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
        .map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

/**
 * The pager under every long list: "הקודם · עמוד 2 מתוך 9 · הבא". The server pages (each list answers { page, pages });
 * onGo(page) loads that page. Hidden while there is one page only (and before the first answer).
 */
export function Pager({ id, page, pages, onGo }: { id?: string; page: number; pages: number | null; onGo: (p: number) => void }) {
  const last = Math.max(1, pages ?? 1);
  return (
    <div id={id} className="pager" hidden={pages === null || last <= 1}>
      <button className="btn sm" disabled={page <= 1} onClick={() => page - 1 >= 1 && onGo(page - 1)}>
        הקודם
      </button>
      <span className="small muted num">{pages === null ? "" : `עמוד ${page} מתוך ${last}`}</span>
      <button className="btn sm" disabled={page >= last} onClick={() => page + 1 <= last && onGo(page + 1)}>
        הבא
      </button>
    </div>
  );
}

/** <a href="#"> that does something here instead of navigating (the old data-contact / data-call links). */
export function ActionLink({ onClick, className, children }: { onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <a
      href="#"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </a>
  );
}
