/**
 * Alarm email subscriptions — who is emailed about which Alarms.
 *
 * ⚠ Nobody may be subscribed to a Plant they cannot see, and the server says
 * so in a sentence when asked to; it re-checks at sending time too, so each
 * listed subscription carries `sending` and, when false, the reason.
 *
 * A platform administrator belongs to no Client and passes `client_id`; for a
 * Client Admin it is ignored and their own Client is used.
 */

import { z } from "zod";
import { request } from "../client";
import { parse } from "../schemas";

export const SEVERITY_CODES = ["low", "medium", "high", "critical"] as const;

export const LastNotificationSchema = z.object({
  status: z.string(),
  at: z.string().nullable(),
  subject: z.string().nullable(),
  failure_reason: z.string().nullable(),
});
export type LastNotification = z.infer<typeof LastNotificationSchema>;

export const SubscriptionSchema = z.object({
  id: z.number(),
  client_id: z.number(),
  user_id: z.number(),
  email: z.string(),
  full_name: z.string().nullable(),
  role_code: z.string().nullable(),
  /** null: every Plant of the Client. */
  plant_id: z.number().nullable(),
  plant_code: z.string().nullable(),
  plant_name: z.string().nullable(),
  channel: z.string(),
  min_severity: z.string(),
  enabled: z.boolean(),
  receives: z.array(z.string()),
  /** Whether a real Alarm would be emailed now — the server's verdict. */
  sending: z.boolean(),
  not_sent_reason: z.string().nullable(),
  last_notification: LastNotificationSchema.nullable(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const MemberSchema = z.object({
  user_id: z.number(),
  email: z.string(),
  full_name: z.string().nullable(),
  is_active: z.boolean(),
  role_code: z.string(),
  plant_ids: z.array(z.number()),
  sees_every_plant: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

export const SubscriptionOptionsSchema = z.object({
  client_id: z.number(),
  members: z.array(MemberSchema),
  plants: z.array(z.object({ id: z.number(), code: z.string(), name: z.string() })),
  channels: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      available: z.boolean(),
      configured: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  severities: z.array(z.object({ code: z.string(), receives: z.array(z.string()) })),
});
export type SubscriptionOptions = z.infer<typeof SubscriptionOptionsSchema>;

const clientParam = (clientId: number | null) =>
  clientId === null ? {} : { client_id: clientId };

export async function listSubscriptions(clientId: number | null): Promise<Subscription[]> {
  return parse(
    z.array(SubscriptionSchema),
    await request("/notification-subscriptions", { params: clientParam(clientId) }),
    "GET /notification-subscriptions",
  );
}

export async function subscriptionOptions(
  clientId: number | null,
): Promise<SubscriptionOptions> {
  return parse(
    SubscriptionOptionsSchema,
    await request("/notification-subscriptions/options", { params: clientParam(clientId) }),
    "GET /notification-subscriptions/options",
  );
}

export async function createSubscription(input: {
  user_id: number;
  plant_id: number | null;
  min_severity: string;
  client_id: number | null;
}): Promise<unknown> {
  const { client_id, ...rest } = input;
  return request("/notification-subscriptions", {
    method: "POST",
    body: { ...rest, channel: "email", ...clientParam(client_id) },
  });
}

export async function updateSubscription(
  id: number,
  body: { min_severity?: string; enabled?: boolean },
): Promise<unknown> {
  return request(`/notification-subscriptions/${id}`, { method: "PATCH", body });
}

export async function deleteSubscription(id: number): Promise<void> {
  await request(`/notification-subscriptions/${id}`, { method: "DELETE" });
}

/** Queues one test email through the real sender; its result shows on the list. */
export async function sendTest(id: number): Promise<{ notification_id: number; email: string }> {
  return (await request(`/notification-subscriptions/${id}/test`, { method: "POST" })) as {
    notification_id: number;
    email: string;
  };
}
