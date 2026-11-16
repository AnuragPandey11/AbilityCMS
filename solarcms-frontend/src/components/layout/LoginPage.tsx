/**
 * Login.
 *
 * The backend returns an **identical 401** for a wrong password, an unknown user
 * and a deactivated account. Do not try to be more helpful: distinguishing them
 * here reintroduces the account enumerator the backend was careful to avoid
 * (§3.3). The only branch is 409 — several Clients — which needs a picker.
 *
 * The page is the client's artwork (`LoginPage.css`) with this card on top. It
 * is dark whatever the operating system's theme and uses its own colours rather
 * than the app's tokens, which switch with the theme, and its own face —
 * Poppins, the artwork's — rather than the app's Inter.
 */

import { useState, type FormEvent } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { setPersistTokens } from "@/api/tokens";
import { BrandMark } from "@/components/layout/BrandMark";
import {
  ArrowRightIcon,
  DesktopIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  MailIcon,
  PhoneIcon,
  TabletIcon,
} from "@/components/layout/loginArt";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
import "./LoginPage.css";

const CYAN = "text-[#37d6ee]";

const fieldShell =
  "login-field flex h-[58px] [@media(max-height:760px)]:h-[50px] items-center gap-3 rounded-2xl border border-white/25 bg-white/[0.04] px-4 " +
  "transition focus-within:border-[#37d6ee] focus-within:bg-white/[0.07] focus-within:shadow-[0_0_0_3px_rgba(55,214,238,0.18)]";
const fieldInput =
  "min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-white/80 focus:outline-none";

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Ticked by default: before this box existed a sign-in always survived a
  // reload, and unticking it is what opts out (tokens stay in this tab only).
  const [remember, setRemember] = useState(true);
  const [clientId, setClientId] = useState("");
  const [needsClient, setNeedsClient] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setPersistTokens(remember);
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
    <div className="login-stage" style={{ colorScheme: "dark" }}>
      <form
        onSubmit={submit}
        className="login-card rounded-[28px] border border-[#37d6ee]/60 bg-[#071a33]/80 p-7 shadow-[0_0_46px_rgba(55,214,238,0.18),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-md sm:p-10 [@media(max-height:760px)]:sm:py-7"
      >
        <div className="login-card-logo mb-6">
          <BrandMark height={60} onNavy />
        </div>

        <h1 className="leading-tight">
          <span className="block text-[clamp(1.5rem,2vw,2rem)] font-semibold">Welcome to</span>
          <span className="block text-[clamp(2.1rem,3vw,2.9rem)] font-bold">
            Ability <span className={CYAN}>CMS</span>
          </span>
        </h1>
        <p className="mt-4 text-[15px] text-white/90 [@media(max-height:760px)]:mt-2">
          Sign in to access your monitoring platform
        </p>

        <div className="login-fields mt-9 space-y-5 [@media(max-height:760px)]:mt-6 [@media(max-height:760px)]:space-y-4">
          <label className={fieldShell}>
            <MailIcon size={26} className="shrink-0 text-white/90" strokeWidth={1.5} />
            <span className="sr-only">Email</span>
            <input
              type="email"
              value={email}
              placeholder="Email"
              autoComplete="username"
              onChange={(event) => setEmail(event.target.value)}
              className={fieldInput}
              required
            />
          </label>

          <label className={fieldShell}>
            <LockIcon size={26} className="shrink-0 text-white/90" strokeWidth={1.5} />
            <span className="sr-only">Password</span>
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              placeholder="Password"
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              className={fieldInput}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((shown) => !shown)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
              title={showPassword ? "Hide password" : "Show password"}
              // Out of the tab order: tabbing from the password goes to the
              // checkbox, as it would on any other sign-in form.
              tabIndex={-1}
              className="shrink-0 rounded-md p-1 text-white/90 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#37d6ee]"
            >
              {showPassword ? (
                <EyeIcon size={26} strokeWidth={1.5} />
              ) : (
                <EyeOffIcon size={26} strokeWidth={1.5} />
              )}
            </button>
          </label>

          {needsClient ? (
            <label className={fieldShell}>
              <span className="sr-only">Client id</span>
              <input
                type="number"
                value={clientId}
                placeholder="Client id"
                onChange={(event) => setClientId(event.target.value)}
                className={fieldInput}
                required
              />
            </label>
          ) : null}
        </div>

        <label className="login-remember mt-6 [@media(max-height:760px)]:mt-4 flex cursor-pointer items-center gap-3 text-[15px]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            className="h-5 w-5 shrink-0 rounded-[5px] border border-white/60 bg-transparent accent-[#37d6ee]"
          />
          Remember me
        </label>

        {message ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-[#ff6b86]/50 bg-[#ff6b86]/10 px-3.5 py-2.5 text-[13px] text-[#ffb3c0]"
          >
            {message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="login-submit mt-8 [@media(max-height:760px)]:mt-5 flex h-[58px] [@media(max-height:760px)]:h-[50px] w-full items-center justify-center gap-3 rounded-full bg-gradient-to-r from-[#33d3ee] to-[#6fe3f5] text-lg font-bold text-[#06203a] shadow-[0_6px_26px_rgba(55,214,238,0.35)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-60"
        >
          {busy ? (
            "Signing in…"
          ) : (
            <>
              Sign In
              <ArrowRightIcon size={24} strokeWidth={2} />
            </>
          )}
        </button>

        <div className="login-devices mt-9 flex items-end justify-center gap-9 text-white/90 [@media(max-height:760px)]:hidden" aria-hidden="true">
          <DesktopIcon size={46} strokeWidth={1.3} />
          <TabletIcon size={40} strokeWidth={1.3} />
          <PhoneIcon size={40} strokeWidth={1.3} />
        </div>
        <p className="mt-3 text-center text-[15px] text-white/95 [@media(max-height:760px)]:mt-5">
          Secure <span className="mx-3 text-white/50">|</span>
          Scalable <span className="mx-3 text-white/50">|</span>
          Cloud Ready
        </p>
      </form>
    </div>
  );
}
