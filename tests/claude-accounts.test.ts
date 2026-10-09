import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ClaudeAccounts, MACHINE } from '../src/server/claude-accounts.js';

// A stand-in for `claude`: its own folder (CLAUDE_CONFIG_DIR) is signed in once `logged-in` holds an
// email; this computer's own is always signed in; a token in the environment is signed in, with no email.
const FAKE = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const [cmd, sub] = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
const mine = !dir || dir === process.env.FAKE_MACHINE_DIR;
const file = dir && path.join(dir, 'logged-in');
if (cmd === 'auth' && sub === 'status') {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }));
  else if (mine) console.log(JSON.stringify({ loggedIn: true, email: 'me@machine.dev', subscriptionType: 'pro' }));
  else if (fs.existsSync(file)) console.log(JSON.stringify({ loggedIn: true, email: fs.readFileSync(file, 'utf8'), subscriptionType: 'max' }));
  else { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
} else if (cmd === 'auth' && sub === 'login') {
  console.log('Opening browser: https://claude.ai/oauth/authorize?code=true&state=abc');
  process.stdout.write('Paste code here if prompted > ');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\\r|\\n/);
    buf = lines.pop();
    for (const code of lines.filter(Boolean)) {
      if (code !== 'GOODCODE123') { console.log('OAuth error: Invalid code'); continue; }
      fs.writeFileSync(file, process.env.FAKE_EMAIL);
      console.log('Login successful');
      process.exit(0);
    }
  });
} else if (cmd === 'auth' && sub === 'logout') {
  if (file) fs.rmSync(file, { force: true });
}
`;

const root = mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
after(() => rmSync(root, { recursive: true, force: true }));
const claude = path.join(root, 'claude');
writeFileSync(claude, FAKE);
chmodSync(claude, 0o755);
// This computer's own Claude folder, with what every account shares.
const own = path.join(root, 'own-claude');
mkdirSync(path.join(own, 'skills'), { recursive: true });
writeFileSync(path.join(own, 'settings.json'), '{}');
writeFileSync(path.join(own, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } }, projects: { '/work': { hasTrustDialogAccepted: true } } }));

let n = 0;
function office(email = 'alice@example.com') {
  const data = path.join(root, `data-${n++}`);
  let changes = 0;
  let switches = 0;
  const base = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: own, FAKE_MACHINE_DIR: own, FAKE_EMAIL: email });
  const accounts = new ClaudeAccounts(data, claude, base, () => changes++, () => switches++);
  return { accounts, data, base, changes: () => changes, switches: () => switches };
}

async function until<T>(what: string, get: () => T | undefined | false): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function signIn(o: ReturnType<typeof office>, again?: string) {
  assert.equal(o.accounts.add(again), undefined);
  await until('the sign-in page', () => o.accounts.state().adding?.url);
  assert.equal(o.accounts.code('GOODCODE123'), undefined);
  return until('the new account', () => !o.accounts.state().adding && o.accounts.state().active !== MACHINE && o.accounts.state().active);
}

test("workers start on this computer's own Claude until another is added", async () => {
  const { accounts, base } = office();
  await accounts.look(true);
  const s = accounts.state();
  assert.equal(s.active, MACHINE);
  assert.deepEqual(s.list, [{ id: MACHINE, how: 'machine', who: 'me@machine.dev', plan: 'Pro' }]);
  assert.deepEqual(accounts.apply(base()), base());
  assert.match(accounts.activeName(), /this computer's own \(me@machine\.dev\)/);
});

test("an account added with Claude's sign-in page gets its own folder, with this computer's setup in it", async () => {
  const o = office();
  const id = await signIn(o);
  const s = o.accounts.state();
  assert.deepEqual(s.list[1], { id, how: 'login', who: 'alice@example.com', plan: 'Max', signedOut: undefined });
  assert.equal(o.switches(), 1);

  const home = path.join(o.data, 'claude-accounts', id);
  const env = o.accounts.apply({ ...o.base(), CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-the-office-own-token-xxxxxxxx' }, ['/work']);
  assert.equal(env.CLAUDE_CONFIG_DIR, home);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the office's own token doesn't reach it");
  assert.ok(lstatSync(path.join(home, 'settings.json')).isSymbolicLink());
  assert.ok(lstatSync(path.join(home, 'skills')).isSymbolicLink());
  // Its conversations are this computer's, so a worker restarted on it resumes its own.
  assert.ok(lstatSync(path.join(home, 'projects')).isSymbolicLink());
  assert.ok(existsSync(path.join(own, 'projects')));
  assert.ok(!existsSync(path.join(home, 'agents')), "what this computer's Claude doesn't have isn't made up");
  const config = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(config.mcpServers, { docs: { command: 'docs-mcp' } });
  assert.equal(config.hasCompletedOnboarding, true);
  assert.equal(config.projects['/work'].hasTrustDialogAccepted, true);

  // Back to this computer's own, and over again.
  const key = o.accounts.key();
  assert.equal(o.accounts.use(MACHINE), undefined);
  assert.equal(o.accounts.state().active, MACHINE);
  assert.notEqual(o.accounts.key(), key);
  assert.equal(o.accounts.apply(o.base()).CLAUDE_CONFIG_DIR, own);
  assert.equal(o.accounts.use(id), undefined);
  assert.equal(o.accounts.apply(o.base()).CLAUDE_CONFIG_DIR, home);
  assert.equal(o.switches(), 3);
  assert.match(o.accounts.use('0badc0de') ?? '', /gone/);
});

test("a wrong code says so and waits for the right one; cancelling leaves nothing behind", async () => {
  const o = office();
  o.accounts.add();
  await until('the sign-in page', () => o.accounts.state().adding?.url);
  assert.match(o.accounts.code('nope') ?? '', /doesn't look like/);
  o.accounts.code('WRONGCODE99');
  await until('the complaint', () => o.accounts.state().adding?.error);
  assert.equal(o.accounts.state().adding?.sent, false);
  o.accounts.cancel();
  assert.equal(o.accounts.state().adding, undefined);
  assert.equal(o.accounts.state().list.length, 1);
  const folders = path.join(o.data, 'claude-accounts');
  assert.ok(!existsSync(folders) || readdirSync(folders).length === 0);
});

test('signing in to the same account again replaces the older one', async () => {
  const o = office('bob@example.com');
  const first = await signIn(o);
  o.accounts.use(MACHINE);
  const second = await signIn(o);
  assert.notEqual(first, second);
  await until('the older one gone', () => !existsSync(path.join(o.data, 'claude-accounts', first)));
  assert.deepEqual(o.accounts.state().list.map((a) => a.id), [MACHINE, second]);
});

test('a token from claude setup-token is an account too, on this computer’s own folder', async () => {
  const o = office();
  assert.match((await o.accounts.token('not-a-token')) ?? '', /setup-token/);
  assert.equal(await o.accounts.token('  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123  '), undefined);
  const s = o.accounts.state();
  assert.equal(s.list.length, 2);
  assert.equal(s.list[1].how, 'token');
  assert.equal(s.active, s.list[1].id);
  const env = o.accounts.apply(o.base());
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123');
  assert.equal(env.CLAUDE_CONFIG_DIR, own);
  // The same token again is the same account.
  await o.accounts.token('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123');
  assert.equal(o.accounts.state().list.length, 2);
});

test('removing the account in use signs it out, deletes its folder and goes back to this computer’s own', async () => {
  const o = office();
  const id = await signIn(o);
  const home = path.join(o.data, 'claude-accounts', id);
  assert.ok(existsSync(home));
  assert.match((await o.accounts.remove(MACHINE)) ?? '', /can't be removed/);
  assert.equal(await o.accounts.remove(id), undefined);
  assert.ok(!existsSync(home));
  assert.equal(o.accounts.state().active, MACHINE);
  assert.equal(o.accounts.state().list.length, 1);
  assert.deepEqual(o.accounts.apply(o.base()), o.base());
});

test('an account whose login is gone shows as signed out, and signing it in again keeps it', async () => {
  const o = office();
  const id = await signIn(o);
  rmSync(path.join(o.data, 'claude-accounts', id, 'logged-in'));
  await o.accounts.look(true);
  assert.equal(o.accounts.state().list[1].signedOut, true);
  o.accounts.use(MACHINE);
  assert.equal(await signIn(o, id), id);
  await o.accounts.look(true);
  assert.equal(o.accounts.state().list[1].signedOut, undefined);
  assert.equal(o.accounts.state().list.length, 2);
});
