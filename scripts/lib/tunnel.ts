/** ngrok tunnel to the local tools server (provider A's webhooks come from the internet). */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** NGROK_AUTHTOKEN, else the token saved by `ngrok config add-authtoken` (v2 or v3 config). */
export function ngrokAuthtoken(): string | undefined {
  if (process.env.NGROK_AUTHTOKEN) return process.env.NGROK_AUTHTOKEN;
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ngrok", "ngrok.yml"),
    join(homedir(), ".config", "ngrok", "ngrok.yml"),
    join(homedir(), "Library", "Application Support", "ngrok", "ngrok.yml"),
    join(homedir(), ".ngrok2", "ngrok.yml"),
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const cfg = parseYaml(readFileSync(file, "utf8")) as { authtoken?: string; agent?: { authtoken?: string } };
      const token = cfg?.agent?.authtoken ?? cfg?.authtoken;
      if (token) return token;
    } catch {
      // unreadable config: try the next one
    }
  }
  return undefined;
}

export interface Tunnel {
  url: string;
  close: () => Promise<void>;
}

/** Open an https tunnel to 127.0.0.1:<port>. Throws with a readable message when ngrok is unavailable. */
export async function openTunnel(port: number): Promise<Tunnel> {
  const authtoken = ngrokAuthtoken();
  if (!authtoken) throw new Error("no ngrok authtoken (set NGROK_AUTHTOKEN or run `ngrok config add-authtoken <token>`)");
  const ngrok = await import("@ngrok/ngrok");
  const listener = await ngrok.forward({ addr: `127.0.0.1:${port}`, authtoken });
  const url = listener.url();
  if (!url) throw new Error("ngrok returned no URL");
  return { url, close: () => listener.close() };
}
