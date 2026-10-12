"""ChatGPT / Codex OAuth via the device-code flow (same flow Hermes Agent uses).

Flow:
1. POST {issuer}/api/accounts/deviceauth/usercode {client_id} -> device_auth_id, user_code, interval
2. User opens {issuer}/codex/device and enters user_code.
3. Poll POST {issuer}/api/accounts/deviceauth/token {device_auth_id, user_code};
   403/404 = still pending, 200 = {authorization_code, code_verifier}.
4. Exchange at {issuer}/oauth/token (authorization_code + PKCE verifier).
5. Refresh at {issuer}/oauth/token (refresh_token grant) shortly before the JWT expires.

None of this is a documented public API; it may change without notice. Tokens never
leave the backend and are never logged.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from ..credentials import CredentialStore
from .base import AuthState, ProviderError

log = logging.getLogger(__name__)

ISSUER = "https://auth.openai.com"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
TOKEN_URL = f"{ISSUER}/oauth/token"
USERCODE_URL = f"{ISSUER}/api/accounts/deviceauth/usercode"
DEVICE_TOKEN_URL = f"{ISSUER}/api/accounts/deviceauth/token"
VERIFICATION_URL = f"{ISSUER}/codex/device"
REDIRECT_URI = f"{ISSUER}/deviceauth/callback"

REFRESH_SKEW_SECONDS = 120
DEVICE_LOGIN_TIMEOUT_SECONDS = 15 * 60
MAX_TRANSIENT_POLL_ERRORS = 6
CRED_NAME = "codex"

# Errors after which the stored refresh token can never work again.
_RELOGIN_ERRORS = {"invalid_grant", "invalid_token", "invalid_request", "refresh_token_reused"}


def decode_jwt_claims(token: str | None) -> dict[str, Any]:
    if not token or token.count(".") < 2:
        return {}
    payload = token.split(".")[1]
    try:
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, json.JSONDecodeError):
        return {}


def account_info(access_token: str, id_token: str | None = None) -> dict[str, Any]:
    auth = decode_jwt_claims(access_token).get("https://api.openai.com/auth", {}) or {}
    id_claims = decode_jwt_claims(id_token)
    return {
        "account_id": auth.get("chatgpt_account_id"),
        "plan": auth.get("chatgpt_plan_type"),
        "residency": auth.get("chatgpt_data_residency") or auth.get("chatgpt_compute_residency"),
        "email": id_claims.get("email"),
        "expires_at": decode_jwt_claims(access_token).get("exp"),
    }


@dataclass
class PendingLogin:
    user_code: str
    verification_url: str
    started_at: float
    task: asyncio.Task[None]


class CodexAuth:
    def __init__(
        self,
        store: CredentialStore,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        *,
        codex_cli_home: Path | None = None,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:
        self.store = store
        self._client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=15.0))
        self._codex_home = codex_cli_home or Path.home() / ".codex"
        self._sleep = sleep
        self._refresh_lock = asyncio.Lock()
        self.pending: PendingLogin | None = None
        self.last_error: str | None = None
        self._state_override: AuthState | None = None

    # ---- status -------------------------------------------------------------

    def _creds(self) -> dict[str, Any] | None:
        try:
            return self.store.load(CRED_NAME)
        except (OSError, ValueError):
            log.warning("Codex credentials could not be read")
            return None

    def state(self) -> AuthState:
        if self.pending is not None:
            return "connecting"
        if self._state_override is not None:
            return self._state_override
        creds = self._creds()
        if not creds:
            return "not_connected"
        if not creds.get("refresh_token") and self._expired(creds):
            return "expired"
        return "connected"

    def status(self) -> dict[str, Any]:
        creds = self._creds()
        info = account_info(creds["access_token"], creds.get("id_token")) if creds else {}
        acct = info.get("account_id")
        return {
            "state": self.state(),
            "email": info.get("email"),
            "plan": info.get("plan"),
            "account_id": f"…{acct[-6:]}" if acct else None,
            "expires_at": info.get("expires_at"),
            "source": creds.get("source") if creds else None,
            "pending": (
                {"user_code": self.pending.user_code, "verification_url": self.pending.verification_url}
                if self.pending
                else None
            ),
            "error": self.last_error,
            "codex_cli_login_found": (self._codex_home / "auth.json").exists(),
        }

    @staticmethod
    def _expired(creds: dict[str, Any], skew: int = 0) -> bool:
        exp = decode_jwt_claims(creds.get("access_token")).get("exp")
        return not isinstance(exp, (int, float)) or exp - skew <= time.time()

    # ---- device-code login ---------------------------------------------------

    async def start_device_login(self) -> dict[str, Any]:
        self.cancel_login()
        self.last_error = None
        self._state_override = None
        async with self._client_factory() as client:
            res = await client.post(USERCODE_URL, json={"client_id": CLIENT_ID})
        if res.status_code == 429:
            raise ProviderError("RATE_LIMITED", "OpenAI is rate-limiting login requests. Try again in a minute.")
        if res.status_code != 200:
            raise ProviderError(
                "PROVIDER_UNAVAILABLE",
                f"Could not start ChatGPT login (HTTP {res.status_code}). Device-code login may be disabled for this workspace.",
            )
        body = res.json()
        device_auth_id = body.get("device_auth_id")
        user_code = body.get("user_code") or body.get("usercode")
        if not device_auth_id or not user_code:
            raise ProviderError("PROVIDER_UNAVAILABLE", "Unexpected response from the ChatGPT login service.")
        try:
            interval = max(3.0, float(body.get("interval", 5)))
        except (TypeError, ValueError):
            interval = 5.0

        task = asyncio.create_task(self._poll(device_auth_id, user_code, interval))
        self.pending = PendingLogin(user_code, VERIFICATION_URL, time.time(), task)
        return {"user_code": user_code, "verification_url": VERIFICATION_URL, "expires_in": DEVICE_LOGIN_TIMEOUT_SECONDS}

    def cancel_login(self) -> None:
        if self.pending is not None:
            self.pending.task.cancel()
            self.pending = None

    async def _poll(self, device_auth_id: str, user_code: str, interval: float) -> None:
        deadline = time.time() + DEVICE_LOGIN_TIMEOUT_SECONDS
        transient = 0
        try:
            async with self._client_factory() as client:
                while time.time() < deadline:
                    await self._sleep(interval)
                    try:
                        res = await client.post(
                            DEVICE_TOKEN_URL, json={"device_auth_id": device_auth_id, "user_code": user_code}
                        )
                    except httpx.TransportError:
                        transient += 1
                        if transient >= MAX_TRANSIENT_POLL_ERRORS:
                            self.last_error = "Lost connection to the ChatGPT login service."
                            return
                        continue
                    transient = 0
                    if res.status_code in (403, 404):
                        continue  # user has not approved yet
                    if res.status_code != 200:
                        self.last_error = f"ChatGPT login failed (HTTP {res.status_code})."
                        return
                    body = res.json()
                    await self._exchange(client, body["authorization_code"], body["code_verifier"])
                    return
                self.last_error = "The login code expired. Start the connection again."
        except asyncio.CancelledError:
            raise
        except ProviderError as exc:
            self.last_error = exc.message
        except Exception:  # noqa: BLE001 - surface a safe message, never the raw exception
            log.exception("Codex device login failed")
            self.last_error = "ChatGPT login failed unexpectedly."
        finally:
            if self.pending is not None and self.pending.user_code == user_code:
                self.pending = None

    async def _exchange(self, client: httpx.AsyncClient, code: str, verifier: str) -> None:
        res = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
                "client_id": CLIENT_ID,
                "code_verifier": verifier,
            },
            headers={"Accept": "application/json"},
        )
        if res.status_code != 200:
            raise ProviderError("PERMISSION_DENIED", f"Token exchange failed (HTTP {res.status_code}).")
        tokens = res.json()
        if not tokens.get("access_token"):
            raise ProviderError("PERMISSION_DENIED", "Token exchange returned no access token.")
        self._save(tokens, source="device-code")

    def _save(self, tokens: dict[str, Any], *, source: str, previous: dict[str, Any] | None = None) -> None:
        prev = previous or {}
        self.store.save(
            CRED_NAME,
            {
                "access_token": tokens["access_token"],
                "refresh_token": tokens.get("refresh_token") or prev.get("refresh_token"),
                "id_token": tokens.get("id_token") or prev.get("id_token"),
                "source": source,
                "last_refresh": time.time(),
            },
        )
        self._state_override = None
        self.last_error = None

    # ---- import from Codex CLI ----------------------------------------------

    def import_codex_cli(self) -> None:
        """Copy tokens from ~/.codex/auth.json. Read-only: the CLI file is never modified."""
        path = self._codex_home / "auth.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ProviderError("AUTH_REQUIRED", "No Codex CLI login found. Run `codex login` first.") from None
        except (OSError, json.JSONDecodeError):
            raise ProviderError("AUTH_REQUIRED", "The Codex CLI login file could not be read.") from None
        tokens = data.get("tokens") or {}
        if not tokens.get("access_token"):
            raise ProviderError("AUTH_REQUIRED", "The Codex CLI is not logged in with a ChatGPT account.")
        self.cancel_login()
        self._save(tokens, source="codex-cli")

    # ---- runtime ------------------------------------------------------------

    def disconnect(self) -> None:
        self.cancel_login()
        self.store.delete(CRED_NAME)
        self._state_override = None
        self.last_error = None

    async def access_token(self, *, force_refresh: bool = False) -> tuple[str, dict[str, Any]]:
        """Return a valid access token and account info, refreshing when it is about to expire."""
        async with self._refresh_lock:
            creds = self._creds()
            if not creds:
                raise ProviderError("AUTH_REQUIRED", "Connect your ChatGPT account first.")
            if force_refresh or self._expired(creds, REFRESH_SKEW_SECONDS):
                creds = await self._refresh(creds)
            return creds["access_token"], account_info(creds["access_token"], creds.get("id_token"))

    async def _refresh(self, creds: dict[str, Any]) -> dict[str, Any]:
        refresh_token = creds.get("refresh_token")
        if not refresh_token:
            self._state_override = "expired"
            raise ProviderError("AUTH_EXPIRED", "ChatGPT session expired. Connect again.")
        try:
            async with self._client_factory() as client:
                res = await client.post(
                    TOKEN_URL,
                    data={"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": CLIENT_ID},
                    headers={"Accept": "application/json"},
                )
        except httpx.TransportError:
            raise ProviderError("NETWORK_ERROR", "Could not reach OpenAI to refresh the session.", retryable=True) from None
        if res.status_code == 429:
            raise ProviderError("RATE_LIMITED", "OpenAI rate-limited the session refresh.")
        if res.status_code != 200:
            code = ""
            try:
                err = res.json().get("error")
                code = err.get("code", "") if isinstance(err, dict) else str(err or "")
            except ValueError:
                pass
            if code in _RELOGIN_ERRORS or res.status_code in (400, 401, 403):
                self._state_override = "expired"
                hint = (
                    " The Codex CLI may have rotated this token; reconnect with device login instead of importing."
                    if creds.get("source") == "codex-cli"
                    else ""
                )
                raise ProviderError("AUTH_EXPIRED", "ChatGPT session expired. Connect again." + hint)
            raise ProviderError("PROVIDER_UNAVAILABLE", f"Session refresh failed (HTTP {res.status_code}).")
        tokens = res.json()
        if not tokens.get("access_token"):
            raise ProviderError("AUTH_EXPIRED", "Session refresh returned no access token.")
        self._save(tokens, source=creds.get("source", "device-code"), previous=creds)
        return self._creds() or {}
