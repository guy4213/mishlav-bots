/** The conversation: transcript bubbles and the bot's actions in one timeline (ui.js conversationHtml / toolItem). */
import { Fragment, type ReactNode } from "react";
import { fmtTimeSec } from "../lib/format";
import { REASON_HE, TOOL_HE } from "../lib/labels";
import type { ToolCall, TranscriptLine } from "../lib/types";

/** A tool call in words: its name, its params ("k: v · k: v") and its answer. */
function toolText(c: ToolCall): { title: string; detail: ReactNode } {
  const p = c.params && typeof c.params === "object" ? c.params : {};
  const entries = Object.entries(p);
  const bits = entries.map(([k, v], i) => (
    <Fragment key={k}>
      {i > 0 ? " · " : null}
      {k}: <b>{String(REASON_HE[String(v)] ?? v)}</b>
    </Fragment>
  ));
  const res = c.response?.scheduled_time_he ? ` ← ${c.response.scheduled_time_he}` : c.ok ? "" : ` ← שגיאה: ${c.error ?? c.response?.error ?? ""}`;
  const detail = entries.length || res ? (
    <>
      {bits}
      {res}
    </>
  ) : null;
  return { title: TOOL_HE[c.tool] ?? c.tool, detail };
}

export function ToolItem({ c }: { c: ToolCall }) {
  const t = toolText(c);
  return (
    <li>
      <span className={`tick ${c.ok ? "ok" : "bad"}`}>{c.ok ? "✓" : "✗"}</span>
      <div>
        <b>{t.title}</b> <span className="small muted">{t.detail}</span>
        <div className="small faint">{fmtTimeSec(c.ts)}</div>
      </div>
    </li>
  );
}

type Item = { ts: string; kind: "say"; l: TranscriptLine } | { ts: string; kind: "tool"; c: ToolCall };

/** How many items the timeline has (0: the caller shows its own "nothing yet"). */
export const conversationSize = (lines: TranscriptLine[] = [], tools: ToolCall[] = []) => lines.length + tools.length;

/** Transcript lines and tool actions, by time. */
export function Conversation({ lines = [], tools = [], customer = "לקוח" }: { lines?: TranscriptLine[]; tools?: ToolCall[]; customer?: string }) {
  const items: Item[] = [
    ...lines.map((l) => ({ ts: l.ts, kind: "say" as const, l })),
    ...tools.map((c) => ({ ts: c.ts, kind: "tool" as const, c })),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return (
    <>
      {items.map((it, i) => {
        if (it.kind === "tool") {
          const t = toolText(it.c);
          return (
            <div key={i} className={`action${it.c.ok ? "" : " bad"}`}>
              {it.c.ok ? "🔧" : "⚠"} <b>{t.title}</b> {t.detail ? <span>{t.detail}</span> : null}
            </div>
          );
        }
        const user = it.l.role === "user";
        return (
          <div key={i} className={`bubble ${user ? "user" : "bot"}`}>
            <span className="who">
              {user ? customer : "הבוט"}
              <span className="ts">{fmtTimeSec(it.l.ts)}</span>
            </span>
            {it.l.text}
          </div>
        );
      })}
    </>
  );
}
