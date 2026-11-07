import type { SessionStartInput, TestSession } from "@mishlav/shared";
import type { JsonlFile } from "./jsonl";

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/**
 * The active test session. Part 3 calls run one at a time, so a server-side "current session"
 * is the simplest reliable way to link each tool call to a provider + scenario.
 */
export class SessionStore {
  private active: TestSession | null = null;

  constructor(
    private readonly file: JsonlFile,
    private readonly now: () => Date,
  ) {}

  current(): TestSession | null {
    return this.active;
  }

  start(input: SessionStartInput): TestSession {
    this.end();
    const now = this.now();
    const session: TestSession = {
      session_id: `${input.provider}-${input.scenario}-${stamp(now)}`,
      provider: input.provider,
      scenario: input.scenario,
      actor: input.actor ?? null,
      notes: input.notes ?? null,
      started_at: now.toISOString(),
    };
    this.file.append({ type: "session_start", ...session });
    this.active = session;
    return session;
  }

  end(): TestSession | null {
    const ended = this.active;
    if (ended) {
      this.file.append({ type: "session_end", session_id: ended.session_id, ended_at: this.now().toISOString() });
      this.active = null;
    }
    return ended;
  }
}
