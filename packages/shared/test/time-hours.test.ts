import { describe, expect, it } from "vitest";
import {
  buildToolInputSchemas,
  formatLocalIso,
  fromLocal,
  nextOpenSlot,
  parseRequestedTime,
  resolveCallback,
  toolDefinitions,
  type BusinessHours,
} from "../src";

const TZ = "Asia/Jerusalem";
const bh: BusinessHours = {
  timezone: TZ,
  days: ["sun", "mon", "tue", "wed", "thu"],
  open: "09:00",
  close: "17:00",
  holidays: ["2027-04-22"],
  half_days: [{ date: "2027-04-21", close: "13:00" }],
};
const policy = { min_lead_minutes: 15, max_days_ahead: 60 };
const local = (y: number, m: number, d: number, h: number, mi = 0) => fromLocal(y, m, d, h, mi, TZ);
const iso = (d: Date) => formatLocalIso(d, TZ);

describe("time zone", () => {
  it("converts winter and summer wall time correctly (DST)", () => {
    expect(local(2026, 11, 17, 10).toISOString()).toBe("2026-11-17T08:00:00.000Z"); // UTC+2
    expect(local(2027, 4, 1, 10).toISOString()).toBe("2027-04-01T07:00:00.000Z"); // UTC+3
    expect(iso(local(2027, 4, 1, 10))).toBe("2027-04-01T10:00:00+03:00");
  });

  it("parses requested times with and without offset", () => {
    expect(parseRequestedTime("2026-11-17T10:00:00", TZ)?.toISOString()).toBe("2026-11-17T08:00:00.000Z");
    expect(parseRequestedTime("2026-11-17T10:00", TZ)?.toISOString()).toBe("2026-11-17T08:00:00.000Z");
    expect(parseRequestedTime("2026-11-17T10:00:00Z", TZ)?.toISOString()).toBe("2026-11-17T10:00:00.000Z");
    expect(parseRequestedTime("2026-11-17T10:00:00+02:00", TZ)?.toISOString()).toBe("2026-11-17T08:00:00.000Z");
  });

  it("rejects invalid dates", () => {
    expect(parseRequestedTime("2026-02-31T10:00:00", TZ)).toBeNull();
    expect(parseRequestedTime("next tuesday at 10", TZ)).toBeNull();
    expect(parseRequestedTime("2026-11-17T25:00:00", TZ)).toBeNull();
  });
});

describe("business hours / callback", () => {
  const now = local(2026, 11, 8, 10); // Sunday 10:00

  it("accepts a valid time", () => {
    const r = resolveCallback(local(2026, 11, 10, 10), now, bh, policy); // Tuesday 10:00
    expect(r).toMatchObject({ status: "accepted" });
  });

  it("moves Friday to Sunday 09:00", () => {
    const r = resolveCallback(local(2026, 11, 13, 11), now, bh, policy);
    expect(r.status).toBe("alternative");
    if (r.status === "alternative") {
      expect(r.reason).toBe("non_working_day");
      expect(iso(r.scheduled)).toBe("2026-11-15T09:00:00+02:00");
    }
  });

  it("moves after-hours to the next morning, early morning to the same day", () => {
    const late = resolveCallback(local(2026, 11, 9, 18), now, bh, policy);
    expect(late.status === "alternative" && iso(late.scheduled)).toBe("2026-11-10T09:00:00+02:00");
    const early = resolveCallback(local(2026, 11, 9, 7, 30), now, bh, policy);
    expect(early.status === "alternative" && iso(early.scheduled)).toBe("2026-11-09T09:00:00+02:00");
    const atClose = resolveCallback(local(2026, 11, 9, 17), now, bh, policy);
    expect(atClose.status).toBe("alternative"); // close is exclusive
  });

  it("skips holidays and honours half days", () => {
    const n = local(2027, 4, 18, 10);
    const holiday = resolveCallback(local(2027, 4, 22, 10), n, bh, policy);
    expect(holiday.status === "alternative" && holiday.reason).toBe("holiday");
    expect(holiday.status === "alternative" && iso(holiday.scheduled)).toBe("2027-04-25T09:00:00+03:00"); // Thu holiday -> Sun
    const half = resolveCallback(local(2027, 4, 21, 14), n, bh, policy);
    expect(half.status === "alternative" && iso(half.scheduled)).toBe("2027-04-25T09:00:00+03:00");
    expect(resolveCallback(local(2027, 4, 21, 12), n, bh, policy).status).toBe("accepted");
  });

  it("proposes a rounded time when the request is in the past or too soon", () => {
    const n = local(2026, 11, 8, 10, 7);
    const past = resolveCallback(local(2026, 11, 8, 9), n, bh, policy);
    expect(past.status === "alternative" && past.reason).toBe("in_past");
    expect(past.status === "alternative" && iso(past.scheduled)).toBe("2026-11-08T10:30:00+02:00");
    const soon = resolveCallback(local(2026, 11, 8, 10, 10), n, bh, policy);
    expect(soon.status === "alternative" && soon.reason).toBe("too_soon");
  });

  it("refuses times too far ahead", () => {
    expect(resolveCallback(local(2027, 3, 1, 10), now, bh, policy)).toEqual({ status: "error", error: "too_far" });
  });

  it("nextOpenSlot returns the same time when open", () => {
    const t = local(2026, 11, 10, 12);
    expect(nextOpenSlot(t, bh).getTime()).toBe(t.getTime());
  });
});

describe("tool schemas", () => {
  it("rejects a phone on send_purchase_link (no link to another number)", () => {
    const s = buildToolInputSchemas({ captureDictatedDetails: true });
    expect(s.send_purchase_link.safeParse({ day_id: "x", phone: "0501111111" }).success).toBe(false);
    expect(s.send_purchase_link.safeParse({ day_id: "x" }).success).toBe(true);
  });

  it("allows request_human.phone only in capture mode", () => {
    const test = buildToolInputSchemas({ captureDictatedDetails: true });
    const prod = buildToolInputSchemas({ captureDictatedDetails: false });
    const input = { reason: "wants_human", phone: "0527384915" };
    expect(test.request_human.safeParse(input).success).toBe(true);
    expect(prod.request_human.safeParse(input).success).toBe(false);
    expect(prod.request_human.safeParse({ reason: "bogus" }).success).toBe(false);
  });

  it("end_call accepts an empty body and a closed-list reason", () => {
    const s = buildToolInputSchemas({ captureDictatedDetails: false });
    expect(s.end_call.safeParse({}).success).toBe(true);
    expect(s.end_call.safeParse({ reason: "do_not_call" }).success).toBe(true);
    expect(s.end_call.safeParse({ reason: "whatever" }).success).toBe(false);
  });

  it("exports JSON Schema with the day catalogue as enum", () => {
    const defs = toolDefinitions({ captureDictatedDetails: false, dayIds: ["a", "b"] });
    expect(defs.map((d) => d.name)).toEqual([
      "get_day_info",
      "send_purchase_link",
      "schedule_callback",
      "request_human",
      "end_call",
    ]);
    const props = defs[0]!.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.day_id!.enum).toEqual(["a", "b"]);
    expect(defs[0]!.parameters.additionalProperties).toBe(false);
  });
});
