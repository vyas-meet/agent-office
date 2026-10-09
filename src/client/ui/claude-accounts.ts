import './claude-accounts.css';
import type { ClaudeAccount, ClaudeAccountsState } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from './dom';
import { confirmDialog } from './prompt';
import { copyButton } from './team';

let open = false;

/** What an account is called: its email, or what it is until Claude Code says. */
function nameOf(a: ClaudeAccount): string {
  if (a.how === 'machine') return a.who ? `This computer’s own · ${a.who}` : 'This computer’s own';
  return a.who ?? (a.how === 'token' ? 'A token from claude setup-token' : 'Claude account');
}

/**
 * ✳️ Claude account, for admins: the Claude the office's own workers run on (see
 * server/claude-accounts.ts). Pick one, add another with Claude's sign-in page (or a token from
 * `claude setup-token`), or remove one. Workers started from then on run on the one picked.
 */
export function openClaudeAccounts(net: Net) {
  if (open) return;
  open = true;
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const body = h('div.claude-accounts');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'Claude account', style: 'width:min(600px,100%)' },
    h('header', {}, h('h2', {}, '✳️ Claude account'), close),
    h('div.body.team', {}, h('p.note.lead', {}, 'Workers you start from now on run on the account picked here. The ones already running keep theirs until they restart (R at their desk).'), body),
  );

  // Kept across renders, so a half-typed code or token survives the next update.
  const codeInput = h('input', { type: 'text', placeholder: 'Paste the code here', 'aria-label': 'Code from the sign-in page', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const tokenInput = h('input', { type: 'password', placeholder: 'sk-ant-oat01-…', 'aria-label': 'Token from claude setup-token', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const tokenOpen = { now: false };

  const button = (label: string, onClick: () => void, cls = '') => {
    const b = h('button.btn', { type: 'button', class: cls }, label);
    b.addEventListener('click', onClick);
    return b;
  };

  const form = (input: HTMLInputElement, label: string, send: (v: string) => void, disabled = false) => {
    const go = h('button.btn.primary', { type: 'submit' }, label);
    if (disabled) go.setAttribute('disabled', '');
    const f = h('form.invite-row', {}, input, go) as HTMLFormElement;
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return input.focus();
      send(v);
      input.value = '';
    });
    return f;
  };

  const row = (a: ClaudeAccount, active: boolean, busy: boolean) => {
    const sub = [a.plan, a.how === 'login' ? 'signed in from the office' : a.how === 'token' ? 'setup-token' : 'claude on this computer'].filter(Boolean).join(' · ');
    const actions = h('div.ca-actions');
    if (a.signedOut && a.how === 'login') actions.append(button('Sign in again', () => net.send({ t: 'claudeAccounts.add', id: a.id }), busy ? '' : 'primary'));
    if (active) actions.append(h('span.ca-badge', {}, 'In use'));
    else actions.append(button('Use', () => net.send({ t: 'claudeAccounts.use', id: a.id })));
    if (a.how !== 'machine') {
      const x = button('Remove', () => confirmDialog(`Remove ${nameOf(a)}?`, a.how === 'login' ? 'The office signs it out and forgets it. Workers on it now keep going until they restart.' : 'The office forgets the token. Workers on it now keep going until they restart.', 'Remove', () => net.send({ t: 'claudeAccounts.remove', id: a.id })));
      x.classList.add('ca-remove');
      actions.append(x);
    }
    const status = a.signedOut ? h('span.ca-warn', {}, a.how === 'machine' ? 'Not signed in: run claude auth login on this computer' : 'Signed out') : a.error ? h('span.ca-warn', {}, a.error) : null;
    return h('div.ca-row', { class: active ? 'active' : '' }, h('span.ca-dot', { 'aria-hidden': 'true' }), h('div.ca-who', {}, h('strong', {}, nameOf(a)), h('small', {}, sub), status), actions);
  };

  const adding = (s: NonNullable<ClaudeAccountsState['adding']>) => {
    const box = h('section.ca-add');
    box.append(h('h4', {}, s.again ? 'Signing in again' : 'Adding a Claude account'));
    if (s.error) box.append(h('p.team-status.error', {}, s.error));
    const url = s.url && /^https:\/\//.test(s.url) ? s.url : undefined;
    if (!url) box.append(h('p.note', {}, 'Starting Claude’s sign-in…'));
    else {
      box.append(
        h(
          'ol.ca-steps',
          {},
          h('li', {}, h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open Claude’s sign-in page ↗'), ' and sign in with the account to add.', h('small.ca-tip', {}, 'Already signed in to claude.ai as someone else? Switch accounts there first, or ', copyButton('copy the link', () => url), ' into a private window.')),
          h('li', {}, 'It shows you a code. Paste it here:', form(codeInput, s.sent ? 'Checking…' : 'Send', (code) => net.send({ t: 'claudeAccounts.code', code }), s.sent)),
        ),
      );
    }
    box.append(h('div.ca-actions', {}, button('Cancel', () => net.send({ t: 'claudeAccounts.cancel' }))));
    return box;
  };

  const ways = (error?: string) => {
    const box = h('section.ca-add');
    if (error) box.append(h('p.team-status.error', {}, error));
    box.append(h('div.ca-actions', {}, button('＋ Add a Claude account', () => net.send({ t: 'claudeAccounts.add' }), 'primary')));
    const more = h('details.ca-token', { open: tokenOpen.now }, h('summary', {}, 'Or paste a token from ', h('code', {}, 'claude setup-token')), h('p.note', {}, 'Run it anywhere you’re signed in to that account, then paste what it prints.'), form(tokenInput, 'Add', (token) => net.send({ t: 'claudeAccounts.token', token }))) as HTMLDetailsElement;
    more.addEventListener('toggle', () => (tokenOpen.now = more.open));
    box.append(more);
    return box;
  };

  const render = () => {
    const s = store.claudeAccounts;
    const typing = document.activeElement;
    body.replaceChildren();
    if (!s) {
      body.append(h('p.empty', {}, 'Loading…'));
      return;
    }
    body.append(h('div.ca-list', {}, ...s.list.map((a) => row(a, a.id === s.active, !!s.adding))), s.adding ? adding(s.adding) : ways(s.error));
    for (const i of [codeInput, tokenInput]) if (typing === i && i.isConnected) i.focus();
  };

  const unsub = store.on('claudeAccounts', render);
  const modal = openModal(el, {
    onClose: () => {
      unsub();
      open = false;
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
  net.send({ t: 'claudeAccounts.get' });
}
