// ✳️ Claude account: the one the office's own workers run on (see claude-accounts.ts). Admins only:
// an admin account, or the shared password.
import type { ClaudeAccountsClientMsg } from '../../../shared/protocol.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { str } from '../../office/input.js';
import type { HandlerMap } from './types.js';

/** Whether `c` may switch the office's Claude account; if not, they're told so. */
const admin = (ctx: Ctx, c: Client): boolean => {
  if (ctx.meOf(c.accountId).admin) return true;
  ctx.warn(c, "Only admins can switch the office's Claude account");
  return false;
};

/** Tells everyone which account new workers start on, once a switch went through. */
const switched = (ctx: Ctx, c: Client, before: string) => {
  if (ctx.claudeAccounts.key() !== before) ctx.toastAll(`✳️ ${c.peer.name} switched the office's Claude to ${ctx.claudeAccounts.activeName()}: workers started from now on run on it`);
};

export const claudeAccountsHandlers = {
  'claudeAccounts.get'(ctx, c) {
    if (!admin(ctx, c)) return;
    ctx.sendTo(c, { t: 'claudeAccounts', state: ctx.claudeAccounts.state() });
    void ctx.claudeAccounts.look();
  },
  'claudeAccounts.use'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const before = ctx.claudeAccounts.key();
    ctx.warn(c, ctx.claudeAccounts.use(str(msg.id, 64)));
    switched(ctx, c, before);
  },
  'claudeAccounts.add'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    ctx.warn(c, ctx.claudeAccounts.add(msg.id === undefined ? undefined : str(msg.id, 64)));
  },
  'claudeAccounts.code'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    ctx.warn(c, ctx.claudeAccounts.code(str(msg.code, 4096)));
  },
  'claudeAccounts.cancel'(ctx, c) {
    if (!admin(ctx, c)) return;
    ctx.claudeAccounts.cancel();
  },
  'claudeAccounts.token'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const before = ctx.claudeAccounts.key();
    void ctx.claudeAccounts.token(str(msg.token, 4096)).then((err) => {
      ctx.warn(c, err);
      switched(ctx, c, before);
    });
  },
  'claudeAccounts.remove'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const before = ctx.claudeAccounts.key();
    void ctx.claudeAccounts.remove(str(msg.id, 64)).then((err) => {
      ctx.warn(c, err);
      switched(ctx, c, before);
    });
  },
} satisfies HandlerMap<ClaudeAccountsClientMsg>;
