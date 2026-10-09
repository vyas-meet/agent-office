import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from '@lydell/node-pty';

/*
 * Running `claude` to sign it in and to ask who it's signed in as, for everyone's own sign-ins
 * (signins.ts) and the office's Claude accounts (claude-accounts.ts). A sign-in is Claude Code's
 * own folder, CLAUDE_CONFIG_DIR, or a token in the environment.
 */

/** Credentials the office's own environment may carry. None of them reach anything run on another sign-in. */
export const CLAUDE_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];
/** A sign-in link gets 15 minutes. */
const FLOW_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 30_000;

/** A `claude auth login` the office is running. */
export interface LoginFlow {
  stop(): void;
  /** Types into it: the code from Claude's sign-in page. */
  write(data: string): void;
}

export interface LoginEvents {
  /** The page to open, once Claude Code prints it. */
  url(url: string): void;
  /** The code didn't take, and it waits for another. */
  badCode(said: string): void;
  /** It ended by itself: signed in, or not and why. Not called after stop(). */
  exit(ok: boolean, said: string): void;
}

/**
 * Starts `claude auth login` with `env` (whose CLAUDE_CONFIG_DIR is where the login goes) and
 * reports the page to open; the code that page shows goes back in with write(). Returns why it couldn't start.
 */
export function claudeLogin(claude: string, env: Record<string, string>, cwd: string, on: LoginEvents): LoginFlow | string {
  let p: pty.IPty;
  try {
    // BROWSER=true: Claude "opens" the page with the `true` command and just prints it, for the browser to show.
    // Wide, so the link comes out on one line.
    p = pty.spawn(claude, ['auth', 'login', '--claudeai'], { name: 'xterm-256color', cols: 4000, rows: 40, cwd, env: { ...env, BROWSER: 'true', TERM: 'xterm-256color' } });
  } catch (err) {
    return `Couldn't start Claude Code's sign-in: ${(err as Error).message}`;
  }
  let out = '';
  let shown = false;
  let stopped = false;
  /** Where the output after the code was sent starts, to tell a wrong code apart from the first ask. */
  let sentAt = -1;
  const kill = () => {
    try {
      p.kill();
    } catch {
      // already gone
    }
  };
  // Running out of time ends it like any other failure.
  const timer = setTimeout(kill, FLOW_MS);
  p.onData((d) => {
    out = (out + d).slice(-50_000);
    if (stopped) return;
    if (!shown) {
      const url = /https:\/\/\S*oauth\/authorize\?\S+/.exec(plain(out))?.[0];
      if (url) {
        shown = true;
        on.url(url);
      }
    } else if (sentAt >= 0 && /error|invalid|expired|failed/i.test(plain(out.slice(sentAt)))) {
      // Still running after complaining: the code didn't take.
      const said = lastWords(out.slice(sentAt));
      sentAt = -1;
      on.badCode(said || "That code didn't work — copy it again, or start over");
    }
  });
  p.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (!stopped) on.exit(exitCode === 0, lastWords(out) || 'Signing in stopped before it finished');
  });
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      kill();
    },
    write: (data) => {
      sentAt = out.length;
      p.write(data);
    },
  };
}

/** What `claude auth status` says about a sign-in. */
export interface ClaudeStatus {
  loggedIn: boolean;
  email?: string;
  /** Pro, Max, Team… */
  plan?: string;
  /** It didn't answer at all (not signed out): why. */
  error?: string;
}

export async function claudeStatus(claude: string, env: Record<string, string>): Promise<ClaudeStatus> {
  const r = await run(claude, ['auth', 'status', '--json'], env);
  let s: { loggedIn?: boolean; email?: string; subscriptionType?: string } = {};
  try {
    s = JSON.parse(r.out);
  } catch {
    // older Claude Code, or it failed: nothing to go on
  }
  const plan = s.subscriptionType ? `${s.subscriptionType[0].toUpperCase()}${s.subscriptionType.slice(1)}` : undefined;
  // Signed out, `claude auth status` still answers (and exits 1); anything else went wrong.
  return { loggedIn: !!s.loggedIn, email: s.email, plan, error: r.out ? undefined : r.last || undefined };
}

/** Claude Code's own settings file for an environment: in its CLAUDE_CONFIG_DIR, else in the home folder. */
export function claudeJson(env: Record<string, string>): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** Claude Code's settings in a sign-in's folder, with its first-run questions already answered. */
export function seedClaudeConfig(dir: string, change?: (c: any) => void) {
  const file = path.join(dir, '.claude.json');
  let c: any = {};
  try {
    c = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // new
  }
  const before = JSON.stringify(c);
  c.hasCompletedOnboarding = true;
  change?.(c);
  if (JSON.stringify(c) === before) return;
  try {
    writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error(`agent-office: couldn't write ${file}: ${(err as Error).message}`);
  }
}

/** Folders the office's own Claude (`officeJson`) trusts, the sign-in in `configDir` trusts too: they're the same projects. */
export function carryTrust(officeJson: string, configDir: string, dirs: string[]) {
  let office: any;
  try {
    office = JSON.parse(readFileSync(officeJson, 'utf8'));
  } catch {
    return;
  }
  const trusted = (d: string) => office?.projects?.[d]?.hasTrustDialogAccepted === true;
  if (!dirs.some(trusted)) return;
  seedClaudeConfig(configDir, (c) => {
    c.projects ??= {};
    for (const d of dirs) c.projects[d] = { ...c.projects[d], hasTrustDialogAccepted: true };
  });
}

/** Terminal output as plain text: no colors, links or cursor moves. */
export function plain(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n?/g, '\n');
}

/** The last thing a command said, minus the link and the prompt, for an error line. */
export function lastWords(s: string): string {
  const lines = plain(s)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/https?:\/\/|paste code|opening browser|press enter/i.test(l));
  return (lines.at(-1) ?? '').slice(0, 300);
}

/** Runs a command to the end; never rejects. `last` is the last line it said on stderr (or stdout). */
export function run(cmd: string, args: string[], env: Record<string, string>, input?: string): Promise<{ code: number; out: string; last: string }> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { env, timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as { code?: number | string } | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
      const last = lastWords(stderr || (err && !stdout ? err.message : ''));
      resolve({ code, out: stdout.trim(), last });
    });
    if (input !== undefined) p.stdin?.end(input);
    else p.stdin?.end();
  });
}
