/**
 * A link to an admin page that renders only where that page is ticked for the
 * User (migration 0046). A link that opens onto "this page has not been given
 * to your account" is a dead end (Guardrail 25): better no link at all.
 */

import type { ComponentProps } from "react";
import { Link } from "react-router-dom";
import { useAdminPage } from "@/auth/usePermission";

export function PageLink({
  page,
  ...props
}: ComponentProps<typeof Link> & { page: string }): JSX.Element | null {
  return useAdminPage(page) ? <Link {...props} /> : null;
}
