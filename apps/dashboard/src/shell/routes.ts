/**
 * The screens, who sees which (by role), and the routes: #/<screen>, plus the old bookmarks (#tab=phone) from the
 * dashboard before. The server enforces the same split (apps/backend/src/access.ts): hiding a screen here is only for
 * a clean page - a Mishlav user never opens an admin screen, so none of its requests is sent either.
 */
import type { ComponentType } from "react";
import type { Role } from "../lib/types";
import Calls from "../views/Calls";
import Contacts from "../views/Contacts";
import Gold from "../views/Gold";
import Logs from "../views/Logs";
import Overview from "../views/Overview";
import Reps from "../views/Reps";
import Results from "../views/Results";
import SelfTest from "../views/SelfTest";
import StudyDays from "../views/StudyDays";
import Testing from "../views/Testing";
import Users from "../views/Users";

export interface View {
  id: string;
  title: string;
  icon: string;
  Component: ComponentType;
}

export const VIEWS: { group: string; items: View[] }[] = [
  {
    group: "עבודה",
    items: [
      { id: "overview", title: "סקירה", icon: "overview", Component: Overview },
      { id: "contacts", title: "לקוחות", icon: "users", Component: Contacts },
      { id: "calls", title: "שיחות", icon: "phone", Component: Calls },
      { id: "reps", title: "משימות לנציג", icon: "tasks", Component: Reps },
      { id: "study-days", title: "ימי עיון", icon: "calendar", Component: StudyDays },
    ],
  },
  {
    group: "בדיקות",
    items: [
      { id: "self-test", title: "שיחת בדיקה אליי", icon: "phone", Component: SelfTest },
      { id: "testing", title: "בדיקות", icon: "flask", Component: Testing },
      { id: "results", title: "התקדמות ותוצאות", icon: "chart", Component: Results },
    ],
  },
  {
    group: "מערכת",
    items: [
      { id: "users", title: "משתמשים", icon: "shield", Component: Users },
      { id: "logs", title: "לוגים", icon: "logs", Component: Logs },
      { id: "gold", title: "גולד", icon: "gold", Component: Gold },
    ],
  },
];

/** who sees a screen (default: everyone) */
export const ONLY: Record<string, Role> = { testing: "admin", results: "admin", users: "admin", logs: "admin", gold: "admin", "self-test": "mishlav" };
export const allowed = (id: string, role: Role | null) => !ONLY[id] || ONLY[id] === role;

/** old bookmarks (#tab=phone) from the previous dashboard */
export const LEGACY: Record<string, string> = { phone: "testing", test: "testing", logs: "logs", results: "results" };

export const ALL_VIEWS = VIEWS.flatMap((g) => g.items);
export const OVERVIEW = ALL_VIEWS[0]!;

/** The screen a hash shows for this role: #/<id> when allowed, else an old #tab=..., else the overview. */
export function routeId(hash: string, role: Role | null): string {
  const ids = ALL_VIEWS.filter((v) => allowed(v.id, role)).map((v) => v.id);
  const m = /^#\/([\w-]+)/.exec(hash);
  if (m && ids.includes(m[1]!)) return m[1]!;
  const legacy = /[#&]tab=(\w+)/.exec(hash)?.[1];
  const id = (legacy && LEGACY[legacy]) || "overview";
  return ids.includes(id) ? id : "overview";
}
