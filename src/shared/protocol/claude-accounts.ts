// The office's Claude accounts: the one its own workers run on, and switching it (see server/claude-accounts.ts).

/** A Claude account the office can run its workers on. */
export interface ClaudeAccount {
  /** 'machine' for this computer's own `claude` login. */
  id: string;
  /** This computer's own, one signed in from the office, or a token from `claude setup-token`. */
  how: 'machine' | 'login' | 'token';
  /** Its email, once Claude Code says. */
  who?: string;
  /** Pro, Max… */
  plan?: string;
  /** Its login is gone or ran out: it needs signing in again. */
  signedOut?: boolean;
  error?: string;
}

export interface ClaudeAccountsState {
  /** The account workers started from now on run on. */
  active: string;
  /** This computer's own first, then the ones added, oldest first. */
  list: ClaudeAccount[];
  /** An account being added (or signed in `again`): Claude's sign-in page to open, and whether its code went back. */
  adding?: { url?: string; sent?: boolean; error?: string; again?: boolean };
  /** Why the last add didn't work. */
  error?: string;
}

export type ClaudeAccountsClientMsg =
  /** Admins (everyone, on the shared password): the accounts, looked at again. */
  | { t: 'claudeAccounts.get' }
  /** Workers started from now on run on this one. */
  | { t: 'claudeAccounts.use'; id: string }
  /** Add one with Claude's sign-in page, or sign `id` in again. */
  | { t: 'claudeAccounts.add'; id?: string }
  /** The code Claude's sign-in page gave you. */
  | { t: 'claudeAccounts.code'; code: string }
  | { t: 'claudeAccounts.cancel' }
  /** Add one from a `claude setup-token` token instead. */
  | { t: 'claudeAccounts.token'; token: string }
  | { t: 'claudeAccounts.remove'; id: string };

export type ClaudeAccountsServerMsg =
  /** Sent to admins when asked and whenever the accounts change. */
  { t: 'claudeAccounts'; state: ClaudeAccountsState };
