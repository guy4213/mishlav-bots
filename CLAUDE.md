# CLAUDE.md

## Language — most important
- **Always answer the user in Hebrew.** Every message, every summary, every question. Short, simple, transparent.
- Avoid English words in replies where a Hebrew word exists. File names, commands and code stay as they are.
- Code, code comments and docs in `docs/` are in English. The bot's prompt, knowledge base and dashboard are in Hebrew.

## How to work with Guy
- Say what you are about to do and why, in a sentence or two, before doing it. No surprises.
- Don't over-engineer. Fix the bot with correct **context** (prompt facts, tool descriptions, tool responses) and
  deterministic code — never with word lists, dictionaries or piles of restrictions in the prompt.
- Check yourself before saying something works: `npm test`, `npm run worker:test`, then
  `npm run text:all [-- --engine flash|live|live-extended] [-- -s <id>]` (text run of the scenarios, isolated logs in
  `logs/text-runs/`). For a real call, read `logs/transcripts/`, `logs/events/` and `logs/tool-calls.jsonl` first.
  Run vitest from `C:\Users\...` (capital C, e.g. PowerShell `Set-Location "C:\Users\guy42\Desktop\mishlav-bots"`):
  from a lowercase `c:\` path every test file fails with "Cannot read properties of undefined (reading 'config')".
- When he asks for a report before fixes, report first and wait for approval.
- Commit and push only when he asks.
- Every push to main raises the version in `package.json` by 0.1 (1.0.0 → 1.1.0 → 1.2.0). Admins see it in the
  dashboard ("גרסה v1.1 · עלתה …"), so Guy knows the deploy is live.

## Hard rules
- Never run an ElevenLabs conversation (voice or text) without asking first — it spends his credits.
- Never print `.env` values or secrets.
- Recordings/transcripts of real Mishlav calls contain personal data: no external service without Mishlav's approval.

## Where things are
 Roadmap: `docs/TASKS.md`.
- Bot prompt: `config/prompt.md` · knowledge: `config/knowledge/` · tools: `packages/shared/src/tools.ts`
  (then `npm run tools:export`) · tool logic: `apps/backend/src/tools/handlers.ts`.
- Run everything: `npm run lab` → dashboard at http://127.0.0.1:8787/dashboard. Restart it after changing the prompt,
  the tools or the server.
