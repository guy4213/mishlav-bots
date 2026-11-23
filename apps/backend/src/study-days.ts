/**
 * The study days in Supabase (table study_days), edited from the dashboard ("ימי עיון").
 *
 * LiveKnowledge is the KnowledgeBase the server hands to the tools and the prompt variables: its `days` are
 * replaced on every refresh (after each dashboard change, and every minute, so a second server - local / Render -
 * sees the change too). A failed refresh keeps the last good days; an invalid row is left out and logged.
 * Archived days never reach the bot.
 */
import { datesHe, FORMAT_HE, type KnowledgeBase, type StudyDay, type StudyDayInput, toStudyDay } from "./knowledge";

/** One row of study_days, as PostgREST returns it. */
export interface StudyDayRow {
  id: string;
  title: string;
  topic: string;
  date: string;
  end_date: string | null;
  start_time: string;
  end_time: string;
  format: "zoom" | "hotel";
  series: string | null;
  location: string;
  price_ils: number | string;
  vat_included: boolean;
  open_for_registration: boolean;
  course_number: string | null;
  purchase_url: string | null;
  lecturers: string[] | null;
  academic_hours: number | string | null;
  description: string;
  archived_at: string | null;
  created_at?: string;
  updated_at?: string;
}

/** The columns the dashboard writes (create: + id). Every one is sent, so clearing a field clears it. */
export type StudyDayWrite = Omit<StudyDayRow, "id" | "archived_at" | "created_at" | "updated_at">;

export interface StudyDayStore {
  /** all days, archived ones too, by date */
  studyDays(): Promise<StudyDayRow[]>;
  /** throws StudyDayExists when the id is taken */
  createStudyDay(row: StudyDayWrite & { id: string }): Promise<StudyDayRow>;
  /** null: no such day */
  updateStudyDay(id: string, row: StudyDayWrite): Promise<StudyDayRow | null>;
  /** archived = hidden from the bot; null: no such day */
  setStudyDayArchived(id: string, archived: boolean): Promise<StudyDayRow | null>;
}

export class StudyDayExists extends Error {
  constructor(readonly id: string) {
    super(`study day ${id} already exists`);
  }
}

const num = (v: number | string | null) => (v === null || v === "" ? undefined : Number(v));
const opt = <T>(v: T | null) => (v === null || v === "" ? undefined : v);

/** A row -> StudyDay (the same zod schema as the files). Throws on invalid data. */
export function rowToDay(r: StudyDayRow): StudyDay {
  return toStudyDay(
    {
      id: r.id,
      title: r.title,
      topic: r.topic,
      date: r.date,
      end_date: opt(r.end_date),
      start: r.start_time,
      end: r.end_time,
      format: r.format,
      series: opt(r.series),
      location: r.location,
      price_ils: num(r.price_ils),
      vat_included: r.vat_included,
      open_for_registration: r.open_for_registration,
      course_number: opt(r.course_number),
      purchase_url: opt(r.purchase_url),
      lecturers: r.lecturers ?? [],
      academic_hours: num(r.academic_hours),
    },
    r.description ?? "",
    `study_days ${r.id}`,
  );
}

/** The dashboard's form (validated) -> the columns. */
export function inputToRow(d: StudyDayInput): StudyDayWrite {
  return {
    title: d.title,
    topic: d.topic,
    date: d.date,
    end_date: d.end_date ?? null,
    start_time: d.start,
    end_time: d.end,
    format: d.format,
    series: d.series ?? null,
    location: d.location,
    price_ils: d.price_ils,
    vat_included: d.vat_included,
    open_for_registration: d.open_for_registration,
    course_number: d.course_number?.trim() || null,
    purchase_url: d.purchase_url ?? null,
    lecturers: d.lecturers,
    academic_hours: d.academic_hours ?? null,
    description: d.description.trim(),
  };
}

/** What the dashboard shows for a row: the day as the bot sees it + whether it is valid / archived. */
export function rowForDashboard(r: StudyDayRow) {
  let day: StudyDay | null = null;
  let error: string | null = null;
  try {
    day = rowToDay(r);
  } catch (err) {
    error = (err as Error).message;
  }
  return {
    ...(day ?? {}),
    id: r.id,
    raw: r,
    dates_he: datesHe({ date: r.date, end_date: r.end_date ?? undefined }),
    format_he: FORMAT_HE[r.format],
    archived: !!r.archived_at,
    archived_at: r.archived_at,
    updated_at: r.updated_at ?? null,
    error,
  };
}

export class LiveKnowledge implements KnowledgeBase {
  private current = new Map<string, StudyDay>();
  private signature = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: StudyDayStore,
    readonly general: string,
    private readonly log: (kind: "server" | "error", text: string) => void = () => {},
  ) {}

  get days(): Map<string, StudyDay> {
    return this.current;
  }

  /** Reads the table again. Throws when Supabase can't be read (the days in use stay as they were). */
  async refresh(): Promise<void> {
    const rows = await this.store.studyDays();
    const days = new Map<string, StudyDay>();
    for (const r of rows) {
      if (r.archived_at) continue;
      try {
        days.set(r.id, rowToDay(r));
      } catch (err) {
        this.log("error", `study day left out (invalid in Supabase): ${(err as Error).message}`);
      }
    }
    const signature = rows.map((r) => `${r.id}@${r.updated_at ?? ""}@${r.archived_at ?? ""}`).join("|");
    if (signature !== this.signature) this.log("server", `study days loaded from Supabase: ${days.size} for the bot`);
    this.signature = signature;
    this.current = days;
  }

  /** Every `ms`; a failure is logged and the last good days stay. */
  start(ms = 60_000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => this.log("error", `could not refresh the study days: ${(err as Error).message}`));
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
