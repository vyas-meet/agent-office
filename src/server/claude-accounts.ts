import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeAccount, ClaudeAccountsState } from '../shared/protocol.js';
import { CLAUDE_VARS, carryTrust, claudeJson, claudeLogin, claudeStatus, run, seedClaudeConfig, type ClaudeStatus, type LoginFlow } from './claude-cli.js';

/*
 * The office's Claude accounts
 * ----------------------------
 * The Claude the office's own workers run on (everyone's, on the shared password; an admin's who
 * uses the office's own sign-in): this computer's own `claude` login, or one of the others added
 * here (☰ → ✳️ Claude account). Switching changes what workers started from then on run on; the
 * ones already running keep theirs until they're restarted.
 *
 * Each account added with Claude's sign-in page gets a folder, .agent-office/claude-accounts/<id>/,
 * that is its CLAUDE_CONFIG_DIR, with this computer's Claude settings, CLAUDE.md, agents, commands,
 * skills and plugins linked in, so only the account changes, and its conversations (projects/), so a
 * worker restarted on another account still resumes its own. One added as a token from
 * `claude setup-token` keeps this computer's folder and just puts the token in the environment.
 */

/** This computer's own `claude` login. */
export const MACHINE = 'machine';
const ID = /^[a-f0-9]{8}$/;
/** What every account shares with this computer's own Claude folder. */
const SHARED = ['settings.json', 'CLAUDE.md', 'agents', 'commands', 'skills', 'plugins', 'output-styles', 'projects'];
/** Shared even before this computer's Claude has made it: where conversations are kept, for --resume. */
const ALWAYS = new Set(['projects']);
/** From `claude setup-token`. */
const SETUP_TOKEN = /^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/;
/** The variables a token in the environment takes the place of. */
const TOKEN_VARS = CLAUDE_VARS.filter((k) => k !== 'CLAUDE_CONFIG_DIR' && k !== 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
const LOOK_GAP_MS = 20_000;

interface Saved {
  id: string;
  /** From `claude setup-token`; else it's the login in its folder. */
  token?: string;
  who?: string;
  plan?: string;
  signedOut?: boolean;
}

interface File {
  /** Unset: this computer's own. */
  active?: string;
  list: Saved[];
}

interface Adding {
  /** The folder it signs in to: a new account's, or one signing in again. */
  id: string;
  fresh: boolean;
  flow: LoginFlow;
  url?: string;
  sent?: boolean;
  error?: string;
}

export class ClaudeAccounts {
  private dir: string;
  private file: string;
  private machine: Omit<ClaudeAccount, 'id' | 'how'> = {};
  private adding: Adding | undefined;
  /** Why the last add didn't work, until the next one starts. */
  private error: string | undefined;
  private looking: Promise<void> | undefined;
  /** A look asked for while one was running: it goes once that one's done. */
  private again: Promise<void> | undefined;
  private lookedAt = 0;

  constructor(
    dataDir: string,
    /** The `claude` binary, or null when it isn't installed. */
    private claude: string | null,
    /** The office's own environment, which every account's is built on. */
    private base: () => Record<string, string>,
    private onChange: () => void,
    /** The account workers start on changed. */
    private onSwitch: () => void,
  ) {
    this.dir = path.join(dataDir, 'claude-accounts');
    this.file = path.join(this.dir, 'accounts.json');
  }

  state(): ClaudeAccountsState {
    const f = this.load();
    const list: ClaudeAccount[] = [{ id: MACHINE, how: 'machine', ...this.machine }, ...f.list.map((a) => ({ id: a.id, how: a.token ? ('token' as const) : ('login' as const), who: a.who, plan: a.plan, signedOut: a.signedOut }))];
    const a = this.adding;
    return { active: this.active(f)?.id ?? MACHINE, list, adding: a && { url: a.url, sent: a.sent, error: a.error, again: !a.fresh }, error: this.error };
  }

  /** A short name for the account workers start on, for a toast. */
  activeName(): string {
    const { active, list } = this.state();
    const a = list.find((x) => x.id === active);
    return a?.id === MACHINE ? `this computer's own${a.who ? ` (${a.who})` : ''}` : (a?.who ?? 'another account');
  }

  /** Changes whenever the account workers start on does (to read its plan's limits afresh). */
  key(): string {
    const a = this.active(this.load());
    return a ? `${a.id}:${a.who ?? ''}` : MACHINE;
  }

  /**
   * Puts the account workers start on in `env` (changed in place, and returned). `dirs` are where a
   * worker is about to start, to carry over this computer's folder trust.
   */
  apply(env: Record<string, string>, dirs: string[] = []): Record<string, string> {
    const a = this.active(this.load());
    if (!a) return env;
    if (a.token) {
      for (const k of TOKEN_VARS) delete env[k];
      env.CLAUDE_CODE_OAUTH_TOKEN = a.token;
      return env;
    }
    const own = claudeJson(env);
    for (const k of CLAUDE_VARS) delete env[k];
    env.CLAUDE_CONFIG_DIR = this.home(a.id);
    if (dirs.length) carryTrust(own, env.CLAUDE_CONFIG_DIR, dirs);
    return env;
  }

  /** Workers start on `id` from now on. Returns why it can't. */
  use(id: string): string | undefined {
    const f = this.load();
    if (id !== MACHINE && !f.list.some((a) => a.id === id)) return 'That Claude account is gone';
    if ((f.active ?? MACHINE) === id) return undefined;
    f.active = id === MACHINE ? undefined : id;
    this.save(f);
    if (id !== MACHINE && !f.list.find((a) => a.id === id)?.token) this.share(this.home(id));
    this.onSwitch();
    this.onChange();
    void this.look(true);
    return undefined;
  }

  /**
   * Adds an account with Claude's sign-in page, or signs `again` in once more. The page to open
   * comes through state(). Returns why it can't.
   */
  add(again?: string): string | undefined {
    if (!this.claude) return "Claude Code isn't installed where the office can run it — paste a token from `claude setup-token` instead";
    if (again && !this.load().list.some((a) => a.id === again && !a.token)) return 'That Claude account is gone';
    this.cancel();
    this.error = undefined;
    const id = again ?? randomBytes(4).toString('hex');
    const home = this.prepare(id);
    const flow = claudeLogin(this.claude, this.envOf({ id }), home, {
      url: (url) => this.update(adding, { url }),
      badCode: (said) => this.update(adding, { sent: false, error: said }),
      exit: (ok, said) => {
        if (this.adding !== adding) return;
        this.adding = undefined;
        if (ok) return void this.added(id);
        if (!again) rmSync(home, { recursive: true, force: true });
        this.error = said;
        this.onChange();
      },
    });
    if (typeof flow === 'string') {
      if (!again) rmSync(home, { recursive: true, force: true });
      return flow;
    }
    const adding: Adding = { id, fresh: !again, flow };
    this.adding = adding;
    this.onChange();
    return undefined;
  }

  /** The code Claude's sign-in page showed. */
  code(code: string): string | undefined {
    const a = this.adding;
    if (!a) return 'Start adding a Claude account first';
    const clean = code.trim();
    if (!/^[A-Za-z0-9#_.~-]{8,2048}$/.test(clean)) return "That doesn't look like the code from Claude's sign-in page";
    a.flow.write(`${clean}\r`);
    this.update(a, { sent: true, error: undefined });
    return undefined;
  }

  cancel() {
    const a = this.adding;
    if (!a) return;
    this.adding = undefined;
    a.flow.stop();
    if (a.fresh) rmSync(this.home(a.id), { recursive: true, force: true });
    this.onChange();
  }

  /** Adds an account from a `claude setup-token` token, and starts workers on it. */
  async token(raw: string): Promise<string | undefined> {
    const token = raw.trim();
    if (!SETUP_TOKEN.test(token)) return "That isn't a token from `claude setup-token` (sk-ant-oat01-…)";
    const f = this.load();
    let a = f.list.find((x) => x.token === token);
    if (!a) {
      a = { id: randomBytes(4).toString('hex'), token };
      f.list.push(a);
    }
    f.active = a.id;
    this.save(f);
    this.onSwitch();
    await this.look(true);
    return undefined;
  }

  /** Forgets an account (signing its login out); workers go back to this computer's own if it was theirs. */
  async remove(id: string): Promise<string | undefined> {
    if (id === MACHINE) return "This computer's own Claude can't be removed";
    const f = this.load();
    const a = f.list.find((x) => x.id === id);
    if (!a) return undefined;
    if (this.adding?.id === id) this.cancel();
    f.list = f.list.filter((x) => x !== a);
    const was = f.active === id;
    if (was) f.active = undefined;
    this.save(f);
    if (was) this.onSwitch();
    this.onChange();
    if (!a.token) await this.forget(id);
    return undefined;
  }

  /** Looks at who each account is signed in as, now if `force`, else unless it just did. */
  look(force = false): Promise<void> {
    if (this.looking && force) return (this.again ??= this.looking.then(() => ((this.again = undefined), this.look(true))));
    if (this.looking) return this.looking;
    if (!force && Date.now() - this.lookedAt < LOOK_GAP_MS) return Promise.resolve();
    this.looking = this.lookAll().finally(() => {
      this.lookedAt = Date.now();
      this.looking = undefined;
      this.onChange();
    });
    return this.looking;
  }

  shutdown() {
    this.adding?.flow.stop();
    this.adding = undefined;
  }

  // ---------------------------------------------------------------------------

  private async lookAll() {
    const claude = this.claude;
    if (!claude) {
      this.machine = { error: "Claude Code isn't installed on the office's machine" };
      return;
    }
    const f = this.load();
    const [mine, ...theirs] = await Promise.all([claudeStatus(claude, this.base()), ...f.list.map((a) => claudeStatus(claude, this.envOf(a)))]);
    this.machine = mine.loggedIn ? { who: mine.email, plan: mine.plan } : { signedOut: true, error: mine.error };
    // What it found goes in the file as it is now: it may have changed while looking.
    const now = this.load();
    f.list.forEach((a, i) => {
      const s = theirs[i];
      const b = now.list.find((x) => x.id === a.id);
      if (!b) return;
      // A token's account has no email to show; whether it works shows when a worker starts.
      b.who = s.email ?? b.who;
      b.plan = s.plan ?? b.plan;
      b.signedOut = !s.loggedIn && !b.token ? true : undefined;
    });
    this.save(now);
  }

  /** A new sign-in went through: workers start on it from now on (one already added for that email makes way). */
  private async added(id: string) {
    const s: ClaudeStatus = this.claude ? await claudeStatus(this.claude, this.envOf({ id })) : { loggedIn: false };
    const f = this.load();
    let a = f.list.find((x) => x.id === id);
    if (!a) {
      a = { id };
      f.list.push(a);
    }
    Object.assign(a, { who: s.email, plan: s.plan, signedOut: undefined });
    const twin = s.email ? f.list.find((x) => x !== a && !x.token && x.who === s.email) : undefined;
    if (twin) f.list = f.list.filter((x) => x !== twin);
    f.active = id;
    this.save(f);
    this.share(this.home(id));
    this.onSwitch();
    this.onChange();
    if (twin) await this.forget(twin.id);
    void this.look(true);
  }

  private update(a: Adding, change: Partial<Adding>) {
    if (this.adding !== a) return;
    Object.assign(a, change);
    this.onChange();
  }

  /** The account workers start on; undefined for this computer's own. */
  private active(f: File): Saved | undefined {
    return f.active ? f.list.find((a) => a.id === f.active) : undefined;
  }

  /** The environment `claude` runs in as account `a`. */
  private envOf(a: Pick<Saved, 'id' | 'token'>): Record<string, string> {
    const env = this.base();
    if (a.token) {
      for (const k of TOKEN_VARS) delete env[k];
      env.CLAUDE_CODE_OAUTH_TOKEN = a.token;
    } else {
      for (const k of CLAUDE_VARS) delete env[k];
      env.CLAUDE_CONFIG_DIR = this.home(a.id);
    }
    return env;
  }

  private home(id: string): string {
    if (!ID.test(id)) throw new Error(`not a Claude account id: ${id}`);
    return path.join(this.dir, id);
  }

  /** The account's folder, made on first use, its first-run questions answered and this computer's MCP servers in. */
  private prepare(id: string): string {
    const home = this.home(id);
    if (existsSync(path.join(home, '.claude.json'))) return home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    let servers: unknown;
    try {
      servers = JSON.parse(readFileSync(claudeJson(this.base()), 'utf8'))?.mcpServers;
    } catch {
      // none
    }
    seedClaudeConfig(home, (c) => {
      if (servers && typeof servers === 'object') c.mcpServers = servers;
    });
    this.share(home);
    return home;
  }

  /** Links this computer's Claude settings, CLAUDE.md, agents, commands, skills, plugins and conversations into the account's folder. */
  private share(home: string) {
    const base = this.base();
    const own = base.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    for (const name of SHARED) {
      const from = path.join(own, name);
      const to = path.join(home, name);
      try {
        if (exists(to)) continue;
        if (ALWAYS.has(name)) mkdirSync(from, { recursive: true, mode: 0o700 });
        else if (!existsSync(from)) continue;
        symlinkSync(from, to);
      } catch (err) {
        console.error(`agent-office: couldn't link ${from} into ${home}: ${(err as Error).message}`);
      }
    }
  }

  /** Signs an account's login out (on a Mac it's in the keychain, not the folder) and deletes its folder. */
  private async forget(id: string) {
    const home = this.home(id);
    if (this.claude && existsSync(home)) await run(this.claude, ['auth', 'logout'], this.envOf({ id }));
    rmSync(home, { recursive: true, force: true });
  }

  private load(): File {
    try {
      const f = JSON.parse(readFileSync(this.file, 'utf8')) as File;
      if (f && Array.isArray(f.list)) return { active: f.active, list: f.list.filter((a) => a && typeof a.id === 'string' && ID.test(a.id)) };
    } catch {
      // none yet
    }
    return { list: [] };
  }

  private save(f: File) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(f, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save the Claude accounts: ${(err as Error).message}`);
    }
  }
}

/** Whether something is at `p`, a broken link included. */
function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
