/**
 * RFC 7807 `application/problem+json`, which is what every backend error is
 * (BACKEND_SPEC §8.3).
 *
 * The one field that must never reach a user verbatim is a 500's `detail`: it is
 * deliberately opaque server-side, and treating it as displayable teaches the
 * habit of showing whatever the server said (FRONTEND_SPEC §8, Guardrail 7).
 */

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.problem = problem;
  }

  /** Message safe to put in front of a person. */
  get displayMessage(): string {
    if (this.status >= 500) {
      // Guardrail 7. The real text can carry SQL or another Client's identifiers.
      return "Something went wrong on the server. The details have been logged.";
    }
    if (this.status === 404) {
      // The backend cannot tell "no such Plant" from "another Client's Plant"
      // without leaking the latter's existence, so neither may the UI (§8).
      return "Not found, or not accessible with your current access.";
    }
    return this.problem.detail || this.problem.title;
  }

  /** True when the caller lacked a permission rather than a resource. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  /**
   * 422 covers both field validation and the readings point cap. The cap is not
   * a validation failure the user can fix inline — it means "narrow the range"
   * (§9), so it is rendered differently.
   */
  get isPointCap(): boolean {
    return (
      this.status === 422 && /points?, above the/.test(this.problem.detail)
    );
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function toProblem(
  status: number,
  body: unknown,
  instance: string,
): Problem {
  if (body && typeof body === "object" && "status" in body && "title" in body) {
    return body as Problem;
  }
  // FastAPI's own 422 body is {detail: [...]}; normalise it into the same shape
  // so callers have exactly one error type to handle.
  let detail = "request failed";
  if (body && typeof body === "object" && "detail" in body) {
    const raw = (body as { detail: unknown }).detail;
    detail = typeof raw === "string" ? raw : JSON.stringify(raw);
  }
  return { type: "about:blank", title: "Error", status, detail, instance };
}

/** Field-level errors out of a FastAPI validation body, for inline display. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.status !== 422) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.problem.detail);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const loc = (item as { loc?: unknown[] }).loc ?? [];
    const msg = (item as { msg?: string }).msg ?? "invalid";
    const field = loc.filter((p) => p !== "body" && p !== "query").join(".");
    if (field) out[field] = msg;
  }
  return out;
}
