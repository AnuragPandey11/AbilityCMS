"""Login, refresh, logout, switch-client, and /auth/me.

Tender §33 requires login, logout **and failed login** in the audit trail — a
failed login must be recorded even when the email matches no User at all, which
is why `audit_log.client_id` and `user_id` are nullable and `actor_email` is
stored as text.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from sqlalchemy import text

from solarcms.api.auth import (
    AuthError,
    decode_token,
    hash_password,
    issue_token,
    needs_rehash,
    verify_password,
)
from solarcms.api.deps import CurrentUserDep, SessionDep
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.schemas.common import LoginRequest, TokenPair

router = APIRouter(prefix="/auth", tags=["auth"])


async def _audit_standalone(
    action: str, *, user_id: int | None, email: str | None,
    client_id: int | None = None, request: Request | None = None,
) -> None:
    """Write an audit row in its **own** committed transaction.

    A failed login raises HTTPException, which rolls back the request's
    transaction — taking the audit row with it. Tender §33 requires failed logins
    be recorded, so the row cannot share a transaction with the failure it
    records. This opens its own, commits, and returns before the caller raises.
    """
    async with scoped_session(SecurityContext.anonymous(), role=None) as session:
        await _audit(session, action, user_id=user_id, email=email,
                     client_id=client_id, request=request)


async def _audit(
    session: Any, action: str, *, user_id: int | None, email: str | None,
    client_id: int | None = None, request: Request | None = None,
) -> None:
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, actor_email, action, ip_address,
                               user_agent)
        VALUES (:client_id, :user_id, :email, :action, :ip, :ua)
    """), {
        "client_id": client_id, "user_id": user_id, "email": email, "action": action,
        "ip": request.client.host if request and request.client else None,
        "ua": request.headers.get("user-agent") if request else None,
    })


@router.post("/login", response_model=TokenPair)
async def login(body: LoginRequest, request: Request) -> TokenPair:
    # role=None: authentication happens before any Client context exists, so this
    # runs as the owner. It is the one place that legitimately reads across
    # Clients, and it reads only what it needs to establish the context.
    async with scoped_session(SecurityContext.anonymous(), role=None) as session:
        row = (await session.execute(text("""
            SELECT id, password_hash, is_active, platform_role
              FROM users WHERE email = :email
        """), {"email": body.email})).first()

        if row is None or not verify_password(body.password, row.password_hash):
            failed_user_id = row.id if row else None
            failure = "auth.login.failed"
        elif not row.is_active:
            failed_user_id, failure = row.id, "auth.login.inactive"
        else:
            failed_user_id, failure = None, None

    # Outside the block above: the audit must commit on its own, and the raise
    # must happen after it.
    if failure is not None:
        await _audit_standalone(failure, user_id=failed_user_id, email=body.email,
                                request=request)
        # Identical response whether the User is unknown, the password is wrong,
        # or the account is inactive: distinguishing them turns login into an
        # account enumerator.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")

    async with scoped_session(SecurityContext.anonymous(), role=None) as session:
        row = (await session.execute(text("""
            SELECT id, password_hash, is_active, platform_role
              FROM users WHERE email = :email
        """), {"email": body.email})).first()
        assert row is not None

        if needs_rehash(row.password_hash):
            # Opportunistic upgrade: the plaintext is in hand exactly once.
            await session.execute(
                text("UPDATE users SET password_hash = :h WHERE id = :id"),
                {"h": hash_password(body.password), "id": row.id},
            )

        is_platform_admin = row.platform_role == "super_admin"
        client_id, role_code = None, None

        if not is_platform_admin:
            # The password is verified, so the session now knows *who* it is —
            # it simply has no Client yet. Setting app.user_id lets the
            # memberships_read policy return this User's own rows and nothing
            # else (migration 0014). Without this the lookup is empty and every
            # login fails with "no Client membership".
            await session.execute(
                text("SELECT set_config('app.user_id', :user_id, true)"),
                {"user_id": str(row.id)},
            )
            memberships = (await session.execute(text("""
                SELECT m.client_id, r.code
                  FROM memberships m JOIN roles r ON r.id = m.role_id
                 WHERE m.user_id = :user_id
            """), {"user_id": row.id})).all()

            if not memberships:
                await _audit_standalone("auth.login.no_membership", user_id=row.id,
                                        email=body.email, request=request)
                raise HTTPException(status.HTTP_403_FORBIDDEN, "no Client membership")

            if body.client_id is not None:
                chosen = [m for m in memberships if m.client_id == body.client_id]
                if not chosen:
                    raise HTTPException(status.HTTP_403_FORBIDDEN,
                                        "not a member of that Client")
                client_id, role_code = chosen[0].client_id, chosen[0].code
            elif len(memberships) == 1:
                client_id, role_code = memberships[0].client_id, memberships[0].code
            else:
                # A token carries exactly one active Client (BACKEND_SPEC §8.1),
                # which is what lets the RLS context be a single scalar. Choosing
                # one arbitrarily would silently pick whose data they see.
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "user belongs to several Clients; supply client_id",
                )

        access, expires_at = issue_token(
            user_id=row.id, client_id=client_id, role_code=role_code,
            is_platform_admin=is_platform_admin, token_type="access")
        refresh, _ = issue_token(
            user_id=row.id, client_id=client_id, role_code=role_code,
            is_platform_admin=is_platform_admin, token_type="refresh")

        await session.execute(
            text("UPDATE users SET last_login_at = now() WHERE id = :id"), {"id": row.id})

        # The context is fully known now, so apply it before writing the audit
        # row: audit_log's WITH CHECK requires the row's client_id to match the
        # session's, and until this point the session has none.
        await session.execute(
            text("""SELECT set_config('app.client_id', :client_id, true),
                           set_config('app.is_platform_admin', :platform, true)"""),
            {"client_id": str(client_id) if client_id is not None else "",
             "platform": "true" if is_platform_admin else "false"},
        )
        await _audit(session, "auth.login", user_id=row.id, email=body.email,
                     client_id=client_id, request=request)

    return TokenPair(access_token=access, refresh_token=refresh, expires_at=expires_at)


@router.post("/refresh", response_model=TokenPair)
async def refresh_tokens(
    authorization: Annotated[str | None, Header()] = None,
) -> TokenPair:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing refresh token")
    try:
        claims = decode_token(authorization.split(" ", 1)[1], expect="refresh")
    except AuthError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    await _audit_standalone("auth.refresh", user_id=claims.user_id, email=None,
                            client_id=claims.client_id)
    access, expires_at = issue_token(
        user_id=claims.user_id, client_id=claims.client_id, role_code=claims.role_code,
        is_platform_admin=claims.is_platform_admin, token_type="access")
    rotated, _ = issue_token(
        user_id=claims.user_id, client_id=claims.client_id, role_code=claims.role_code,
        is_platform_admin=claims.is_platform_admin, token_type="refresh")
    return TokenPair(access_token=access, refresh_token=rotated, expires_at=expires_at)


@router.post("/switch-client", response_model=TokenPair)
async def switch_client(client_id: int, user: CurrentUserDep) -> TokenPair:
    """Reissue against another membership (MASTER §3.2)."""
    async with scoped_session(SecurityContext.platform(user.user_id), role=None) as s:
        row = (await s.execute(text("""
            SELECT r.code FROM memberships m JOIN roles r ON r.id = m.role_id
             WHERE m.user_id = :user_id AND m.client_id = :client_id
        """), {"user_id": user.user_id, "client_id": client_id})).first()
        if row is None and not user.is_platform_admin:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "not a member of that Client")
        await _audit(s, "auth.switch_client", user_id=user.user_id, email=None,
                     client_id=client_id)

    access, expires_at = issue_token(
        user_id=user.user_id, client_id=client_id,
        role_code=row.code if row else user.role_code,
        is_platform_admin=user.is_platform_admin, token_type="access")
    refresh, _ = issue_token(
        user_id=user.user_id, client_id=client_id,
        role_code=row.code if row else user.role_code,
        is_platform_admin=user.is_platform_admin, token_type="refresh")
    return TokenPair(access_token=access, refresh_token=refresh, expires_at=expires_at)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def logout(user: CurrentUserDep, request: Request) -> Response:
    async with scoped_session(SecurityContext.platform(user.user_id), role=None) as s:
        await _audit(s, "auth.logout", user_id=user.user_id, email=None,
                     client_id=user.client_id, request=request)
    # 204 must carry no body, so the response is constructed rather than returned
    # as None, which FastAPI would try to serialise.
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me")
async def me(user: CurrentUserDep, session: SessionDep) -> dict[str, Any]:
    """User, role, accessible Plants and accessible dashboards."""
    plants = (await session.execute(
        text("SELECT id, code, name, status FROM plants ORDER BY code"))).all()
    if user.is_platform_admin or user.role_code == "admin":
        dashboards = (await session.execute(
            text("SELECT code FROM dashboards ORDER BY sort_order"))).all()
    else:
        dashboards = (await session.execute(text("""
            SELECT d.code FROM user_dashboard_access uda
              JOIN memberships m ON m.id = uda.membership_id
              JOIN dashboards d  ON d.id = uda.dashboard_id
             WHERE m.user_id = :user_id AND m.client_id = :client_id
             ORDER BY d.sort_order
        """), {"user_id": user.user_id, "client_id": user.client_id})).all()

    return {
        "user_id": user.user_id,
        "client_id": user.client_id,
        "role": user.role_code,
        "platform_admin": user.is_platform_admin,
        "permissions": sorted(user.permissions),
        # RLS already filtered these; the API adds no second filter of its own.
        "plants": [{"id": p.id, "code": p.code, "name": p.name, "status": p.status}
                   for p in plants],
        "dashboards": [d.code for d in dashboards],
    }
