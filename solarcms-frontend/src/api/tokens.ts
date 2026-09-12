/**
 * Token storage.
 *
 * Tokens live in memory for the lifetime of the tab and are mirrored into
 * localStorage so a reload does not force a re-login. `expires_at` is kept but
 * deliberately *not* used to refresh on a timer: the server also revokes on
 * deactivation, and a User disabled mid-session must be ejected on their next
 * request rather than fifteen minutes later (FRONTEND_SPEC §3.2).
 */

const STORAGE_KEY = "solarcms.tokens";

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: string;
}

let current: TokenPair | null = null;
const listeners = new Set<(tokens: TokenPair | null) => void>();

function load(): TokenPair | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TokenPair) : null;
  } catch {
    return null;
  }
}

export function getTokens(): TokenPair | null {
  if (current === null) current = load();
  return current;
}

export function getAccessToken(): string | null {
  return getTokens()?.access_token ?? null;
}

export function setTokens(tokens: TokenPair | null): void {
  current = tokens;
  try {
    if (tokens)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A browser refusing storage is survivable; the in-memory copy still works.
  }
  for (const listener of listeners) listener(tokens);
}

export function onTokensChanged(
  fn: (tokens: TokenPair | null) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
