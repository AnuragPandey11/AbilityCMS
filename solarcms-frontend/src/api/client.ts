/**
 * The single fetch wrapper. Every request in the application goes through it.
 *
 * Two behaviours are load-bearing:
 *
 * 1. **Refresh once, then give up** (§3.2). A 401 triggers exactly one refresh
 *    attempt; concurrent 401s share it rather than each firing their own, which
 *    would rotate the refresh token out from under one another.
 * 2. **Every error becomes an `ApiError`.** Callers never see a bare Response,
 *    so the problem+json contract is honoured in one place instead of at every
 *    call site.
 */

import { ApiError, toProblem } from "./problem";
import { getTokens, setTokens, type TokenPair } from "./tokens";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

/** Called when the session is unrecoverable; AuthProvider routes to login. */
let onSessionLost: () => void = () => {};
export function setSessionLostHandler(fn: () => void): void {
  onSessionLost = fn;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export function buildUrl(path: string, params?: QueryParams): string {
  const url = `${BASE}${path}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    // Repeated keys, not comma-joined: `device_ids` and `tag_ids` are
    // `Query(...)` lists on the backend and only parse in repeated form.
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null)
          search.append(key, String(item));
      }
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

interface RequestOptions {
  method?: string;
  params?: QueryParams;
  body?: unknown;
  /** Set for the refresh call itself, which must not recurse. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

let refreshInFlight: Promise<TokenPair | null> | null = null;

async function refreshTokens(): Promise<TokenPair | null> {
  const tokens = getTokens();
  if (!tokens?.refresh_token) return null;

  // The refresh token goes in the Authorization header — the backend reads it
  // there and checks the token *type*, so sending an access token fails cleanly.
  const response = await fetch(buildUrl("/auth/refresh"), {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.refresh_token}` },
  });
  if (!response.ok) return null;
  const next = (await response.json()) as TokenPair;
  setTokens(next);
  return next;
}

function sharedRefresh(): Promise<TokenPair | null> {
  if (refreshInFlight === null) {
    refreshInFlight = refreshTokens().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getTokens()?.access_token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  return fetch(buildUrl(path, options.params), {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
}

export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  let response = await send(path, options);

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await sharedRefresh();
    if (refreshed === null) {
      setTokens(null);
      onSessionLost();
    } else {
      response = await send(path, options);
    }
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON error body (a proxy 502, say) still has to become an ApiError.
    }
    if (response.status === 401) {
      setTokens(null);
      onSessionLost();
    }
    throw new ApiError(toProblem(response.status, body, path));
  }

  return (await response.json()) as T;
}

/** A CSV/binary download that still needs the bearer token attached. */
export async function requestBlob(
  path: string,
  params?: QueryParams,
): Promise<Blob> {
  const response = await send(path, { params });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* empty */
    }
    throw new ApiError(toProblem(response.status, body, path));
  }
  return response.blob();
}

/**
 * A signed artifact URL is already a credential (BACKEND_SPEC — the route is
 * deliberately outside the bearer guard), so it is opened as-is. It is never
 * re-signed and never cached past its expiry (§6.7).
 */
export function artifactHref(signedPath: string): string {
  return signedPath.startsWith("http") ? signedPath : `${BASE}${signedPath}`;
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
