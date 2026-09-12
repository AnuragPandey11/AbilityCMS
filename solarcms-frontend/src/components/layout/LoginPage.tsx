/**
 * Login.
 *
 * The backend returns an **identical 401** for a wrong password, an unknown user
 * and a deactivated account. Do not try to be more helpful: distinguishing them
 * here reintroduces the account enumerator the backend was careful to avoid
 * (§3.3). The only branch is 409 — several Clients — which needs a picker.
 */

import { useState, type FormEvent } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { Button, Field, PasswordInput, inputClass } from "@/components/ui";
import { BrandMark } from "@/components/layout/BrandMark";
import { ThemeToggle } from "@/theme/ThemeToggle";

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clientId, setClientId] = useState("");
  const [needsClient, setNeedsClient] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const outcome = await login(
      email,
      password,
      needsClient && clientId ? Number(clientId) : undefined,
    );
    setBusy(false);

    switch (outcome.kind) {
      case "ok":
        return;
      case "invalid":
        // Exactly this string, for all three underlying causes.
        setMessage("Invalid email or password.");
        return;
      case "no_membership":
        setMessage(
          "Your account is not attached to a Client. Contact your administrator.",
        );
        return;
      case "choose_client":
        setNeedsClient(true);
        setMessage(
          "This account belongs to several Clients. Enter the Client id to sign in to.",
        );
        return;
      default:
        setMessage(outcome.detail);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-surface px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-card border border-line bg-surface-raised p-6 shadow-card"
      >
        <BrandMark />
        <h1 className="mt-5 text-lg font-semibold text-ink">Sign in</h1>
        <p className="mt-1 text-xs text-ink-muted">
          Plant monitoring platform. Use your work account.
        </p>

        <div className="mt-5 space-y-3">
          <Field label="Email" required>
            <input
              type="email"
              value={email}
              autoComplete="username"
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
              required
            />
          </Field>
          <Field label="Password" required>
            <PasswordInput
              value={password}
              autoComplete="current-password"
              onChange={setPassword}
              required
            />
          </Field>
          {needsClient ? (
            <Field
              label="Client id"
              hint="A token carries exactly one active Client, so one must be chosen at sign-in."
              required
            >
              <input
                type="number"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                className={inputClass}
                required
              />
            </Field>
          ) : null}
        </div>

        {message ? (
          <p
            role="alert"
            className="mt-3 rounded-control border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad"
          >
            {message}
          </p>
        ) : null}

        <Button type="submit" variant="primary" disabled={busy} className="mt-4 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
