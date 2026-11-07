import { z } from "zod";
import { EndCallReason, RequestHumanReason, type ToolName } from "./enums";

export interface ToolSchemaOptions {
  /** Test-only: allow request_human.name/phone (scenario 3). Must be false in production (spec 4.2). */
  captureDictatedDetails: boolean;
}

const dayId = () =>
  z.string().trim().min(1).max(100).describe("Study day id from the closed catalogue in the prompt");

/** Strict zod input schemas for the 5 tools. Unknown fields are rejected. */
export function buildToolInputSchemas(opts: ToolSchemaOptions) {
  const reason = RequestHumanReason.describe("Why a human rep is needed");
  const requestHuman = opts.captureDictatedDetails
    ? z.strictObject({
        reason,
        name: z.string().trim().min(1).max(100).optional().describe("TEST ONLY: name the customer dictated"),
        phone: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .optional()
          .describe("TEST ONLY: phone number the customer dictated, digits exactly as heard"),
      })
    : z.strictObject({ reason });

  return {
    get_day_info: z.strictObject({ day_id: dayId() }),
    send_purchase_link: z.strictObject({ day_id: dayId() }),
    schedule_callback: z.strictObject({
      requested_time: z
        .string()
        .trim()
        .min(10)
        .max(40)
        .describe("ISO 8601 date-time, e.g. 2026-11-17T10:00:00 (Asia/Jerusalem local time when no offset)"),
    }),
    request_human: requestHuman,
    end_call: z.strictObject({
      reason: EndCallReason.optional().describe("Why the call ends"),
    }),
  } satisfies Record<ToolName, z.ZodType>;
}

export type ToolInputSchemas = ReturnType<typeof buildToolInputSchemas>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_day_info:
    "Get the details of one study day (date, hours, location, price, agenda) and the general policies. " +
    "Call before quoting any detail. Use only a day_id from the catalogue.",
  send_purchase_link:
    "Send the customer a purchase link for one study day, to the phone number on file. " +
    "Call only after the customer agreed to receive a link. Never takes a phone number.",
  schedule_callback:
    "Schedule a callback at the time the customer asked for. If the time is outside business hours, " +
    "the response proposes an alternative - confirm it with the customer before ending.",
  request_human:
    "Hand the customer to a human rep: wants a person, pays via a rep, company pays, asks for a discount, " +
    "or asks something that is not in the knowledge base (other).",
  end_call:
    "End the call. Pass the reason: completed, not_interested, do_not_call (asked to be removed), " +
    "voicemail (reached an answering machine - say nothing), already_registered, wrong_number.",
};

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

/** JSON-Schema tool definitions for providers (ElevenLabs webhooks, LiveKit function tools). */
export function toolDefinitions(opts: ToolSchemaOptions & { dayIds: string[] }): ToolDefinition[] {
  const schemas = buildToolInputSchemas(opts);
  return (Object.keys(schemas) as ToolName[]).map((name) => {
    const json = z.toJSONSchema(schemas[name], { target: "draft-7" }) as Record<string, unknown>;
    delete json.$schema;
    const props = json.properties as Record<string, Record<string, unknown>> | undefined;
    if (props?.day_id && opts.dayIds.length > 0) props.day_id.enum = [...opts.dayIds];
    return { name, description: TOOL_DESCRIPTIONS[name], parameters: json };
  });
}
