import { request } from "../client";
import {
  MeSchema,
  TokenPairSchema,
  parse,
  type Me,
  type TokenPair,
} from "../schemas";

export async function login(
  email: string,
  password: string,
  clientId?: number,
): Promise<TokenPair> {
  const body = await request("/auth/login", {
    method: "POST",
    body: { email, password, client_id: clientId ?? null },
    // A 401 here is the answer, not an expired session; refreshing would be noise.
    skipRefresh: true,
  });
  return parse(TokenPairSchema, body, "POST /auth/login");
}

export async function me(): Promise<Me> {
  return parse(MeSchema, await request("/auth/me"), "GET /auth/me");
}

/**
 * Reissue against another membership. The caller must treat this as a full state
 * reset — every cached Plant, Device and Reading belonged to the previous Client
 * (§3.1, Guardrail 10). `AuthProvider.switchClient` is the only intended caller.
 */
export async function switchClient(clientId: number): Promise<TokenPair> {
  const body = await request("/auth/switch-client", {
    method: "POST",
    params: { client_id: clientId },
  });
  return parse(TokenPairSchema, body, "POST /auth/switch-client");
}

export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST" });
}
