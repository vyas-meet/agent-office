import type { ClaudeAccountsState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The Claude accounts the office's own workers can run on (admins only). */
    claudeAccounts: ClaudeAccountsState | null;
  }
  interface Topics {
    claudeAccounts: true;
  }
}

export const claudeAccounts: Slice = {
  init(s) {
    s.claudeAccounts = null;
  },
  on: {
    claudeAccounts(s, m) {
      s.claudeAccounts = m.state;
      return ['claudeAccounts'];
    },
  },
};
