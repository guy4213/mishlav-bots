// The Mishlav side of a phone call: prompt + knowledge (same text the LiveKit worker builds), the 5 tools
// from config/tools.json, and the tools server (each tool POSTs there, like provider C's worker).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/** MISHLAV_ROOT, else the nearest parent holding config/settings.yaml (same rule as the TS and Python sides). */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))) {
  if (process.env.MISHLAV_ROOT) return resolve(process.env.MISHLAV_ROOT);
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'config', 'settings.yaml'))) return dir;
    if (dirname(dir) === dir) throw new Error('repo root not found (no config/settings.yaml above); set MISHLAV_ROOT');
  }
}

/** Like Python's read_text(): newlines normalized to \n (the files are CRLF on Windows checkouts). */
const readText = (path) => readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

/** Substitute {{var}}; an unknown variable is an error (a typo would otherwise reach the caller). */
export function render(template, values) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`prompt variable {{${name}}} has no value`);
    return values[name];
  });
}

/** A YAML value the way Python's f-string prints it (the worker's knowledge_appendix). */
const pyStr = (v) => (v === true ? 'True' : v === false ? 'False' : v == null ? 'None' : String(v));

// Same labels as the tools server (apps/backend/src/knowledge.ts FORMAT_HE).
const FORMAT_HE = { hotel: 'פרונטלי – במלון', zoom: 'מקוון – בזום' };
const FACT_KEYS = ['id', 'date', 'end_date', 'start', 'end', 'format', 'location', 'price_ils', 'open_for_registration'];

function splitFrontMatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return [{}, text];
  return [parseYaml(m[1]) ?? {}, m[2]];
}

/** general.md + every day file, one Hebrew block appended to the prompt. Port of context.py knowledge_appendix. */
export function knowledgeAppendix(root) {
  const kdir = join(root, 'config', 'knowledge');
  const parts = ['# מאגר ידע (מקור המידע היחיד – לא לענות על דבר שלא מופיע כאן או בכלי get_day_info)'];
  const general = join(kdir, 'general.md');
  if (existsSync(general)) parts.push(readText(general).trim());
  const days = existsSync(join(kdir, 'days'))
    ? readdirSync(join(kdir, 'days')).filter((f) => f.endsWith('.md')).sort()
    : [];
  for (const file of days) {
    const stem = basename(file, '.md');
    const [meta, body] = splitFrontMatter(readText(join(kdir, 'days', file)));
    let facts = FACT_KEYS.filter((k) => Object.hasOwn(meta, k))
      .map((k) => `${k}: ${pyStr(meta[k])}`)
      .join(', ');
    if (Object.hasOwn(FORMAT_HE, meta.format)) facts += `, פורמט: ${FORMAT_HE[meta.format]}`;
    const series = Object.hasOwn(meta, 'series') ? meta.series : Object.hasOwn(meta, 'id') ? meta.id : stem;
    facts += `, series: ${pyStr(series)}`;
    const id = Object.hasOwn(meta, 'id') ? pyStr(meta.id) : stem;
    parts.push(`## day_id \`${id}\`\n${facts}\n\n${body.trim()}`);
  }
  return parts.join('\n\n');
}

/**
 * config/prompt.md with the call's variables + the knowledge base. `variables` = GET /test/context's
 * `variables` (first_name, bot_name, interested_day_id, current_datetime, customer_context).
 */
export function buildInstructions(root, variables) {
  const values = {
    first_name: variables.first_name,
    bot_name: variables.bot_name,
    interested_day_id: variables.interested_day_id || 'לא ידוע',
    current_datetime: variables.current_datetime,
    customer_context: variables.customer_context ?? '',
  };
  return `${render(readText(join(root, 'config', 'prompt.md')), values)}\n\n${knowledgeAppendix(root)}`;
}

/** config/tools.json (`npm run tools:export`): the single source of the tool schemas. */
export function loadToolDefinitions(root) {
  return JSON.parse(readFileSync(join(root, 'config', 'tools.json'), 'utf8')).tools;
}

// Said by the bot when the tools server can't be reached (same as the worker's tools_client.py).
export const UNAVAILABLE = { ok: false, error: 'tools_unavailable', message_he: 'תקלה זמנית. להציע שנציג יחזור.' };

/** HTTP client for the tools server. Every request carries the shared secret, the provider and the call id. */
export class ToolsClient {
  constructor({ baseUrl, secret, provider = 'C', callId, timeoutMs = 8000 }) {
    if (!secret || secret.length < 16) throw new Error('TOOLS_SECRET must be at least 16 characters (.env)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.headers = { 'x-tools-secret': secret, 'x-provider': provider, ...(callId && { 'x-call-id': callId }) };
  }

  async #request(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { ...this.headers, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    return { status: res.status, json };
  }

  /** The server is up and accepts our secret. Throws with a clear reason otherwise. */
  async check() {
    let r;
    try {
      r = await this.#request('GET', '/test/session');
    } catch (err) {
      throw new Error(`cannot reach the tools server at ${this.baseUrl} — run \`npm run dev\` first (${err.message})`);
    }
    if (r.status === 401) throw new Error('the tools server rejected TOOLS_SECRET (401)');
    if (r.status >= 400) throw new Error(`the tools server answered HTTP ${r.status}`);
  }

  async callTool(name, params) {
    try {
      const r = await this.#request('POST', `/tools/${name}`, params ?? {});
      return r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  /** The active test session (`npm run session -- start ...`), or null. */
  async currentSession() {
    try {
      return (await this.#request('GET', '/test/session')).json?.session ?? null;
    } catch {
      return null;
    }
  }

  /** Prompt variables for this call (GET /test/context): the same values every provider gets. */
  async callContext({ scenario, firstName, dayId, gender } = {}) {
    const q = new URLSearchParams();
    if (scenario) q.set('scenario', scenario);
    if (firstName) q.set('first_name', firstName);
    if (dayId) q.set('day_id', dayId);
    if (gender) q.set('gender', gender);
    const r = await this.#request('GET', `/test/context${q.size ? `?${q}` : ''}`);
    if (r.status === 404) throw new Error(`unknown scenario ${scenario}`);
    if (!r.json?.variables) throw new Error(`could not read the call context (HTTP ${r.status})`);
    return { scenario: r.json.scenario ?? null, variables: r.json.variables };
  }

  async postMetrics(payload) {
    try {
      const r = await this.#request('POST', '/test/metrics', payload);
      return r.status < 400;
    } catch {
      return false;
    }
  }
}
