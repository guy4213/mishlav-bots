/**
 * Export the 5 tool definitions (JSON Schema) to config/tools.json — the reference for configuring
 * ElevenLabs webhook tools (A) and LiveKit function tools (B/C).
 *
 *   npm run tools:export
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolDefinitions } from "@mishlav/shared";
import { loadKnowledge } from "../apps/backend/src/knowledge";
import { scriptEnv } from "./lib/env";

const env = scriptEnv();
const knowledge = loadKnowledge(join(env.root, "config", "knowledge"));
const capture = env.settings.testing.capture_dictated_details;

const out = {
  generated_by: "npm run tools:export — do not edit by hand",
  capture_dictated_details: capture,
  webhook: {
    method: "POST",
    url: "https://<ngrok-host>/tools/<tool name>",
    headers: {
      "X-Tools-Secret": "<TOOLS_SECRET> (store as a provider secret)",
      "X-Provider": "A | B | C",
      "X-Call-Id": "ElevenLabs: {{system__conversation_id}} · LiveKit: room name",
    },
    body: "JSON object with the tool parameters below",
  },
  tools: toolDefinitions({ captureDictatedDetails: capture, dayIds: [...knowledge.days.keys()] }),
};

const path = join(env.root, "config", "tools.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`Wrote ${path} (${out.tools.length} tools, capture_dictated_details=${capture})`);
