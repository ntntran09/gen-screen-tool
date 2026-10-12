from __future__ import annotations

import asyncio
import base64
import io
import json
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.credentials import CredentialStore
from app.main import create_app
from app.providers.base import GenerateRequest, ProviderError
from app.providers.codex import EDITS_URL, GENERATIONS_URL, CodexProvider
from app.providers.codex_auth import DEVICE_TOKEN_URL, TOKEN_URL, USERCODE_URL, CodexAuth

CSRF = {"x-nodecanvas-csrf": "1"}


def jwt(claims: dict) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()  # noqa: E731
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


def access_token(exp_in: float = 3600, account: str = "acct-123456789") -> str:
    return jwt(
        {
            "exp": time.time() + exp_in,
            "https://api.openai.com/auth": {"chatgpt_account_id": account, "chatgpt_plan_type": "plus"},
        }
    )


def png_bytes(w: int = 4, h: int = 3) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "red").save(buf, "PNG")
    return buf.getvalue()


async def no_sleep(_: float) -> None:
    await asyncio.sleep(0)


def make_auth(tmp_path: Path, handler) -> CodexAuth:
    transport = httpx.MockTransport(handler)
    return CodexAuth(
        CredentialStore(tmp_path / "creds"),
        lambda: httpx.AsyncClient(transport=transport),
        codex_cli_home=tmp_path / "codex",
        sleep=no_sleep,
    )


def test_credential_store_roundtrip_and_not_plaintext(tmp_path: Path) -> None:
    store = CredentialStore(tmp_path)
    store.save("codex", {"access_token": "secret-value"})
    assert store.load("codex") == {"access_token": "secret-value"}
    if sys.platform == "win32":
        assert b"secret-value" not in (tmp_path / "codex.cred").read_bytes()
    store.delete("codex")
    assert store.load("codex") is None


def test_device_code_login_full_flow(tmp_path: Path) -> None:
    polls = {"n": 0}
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if str(req.url) == USERCODE_URL:
            seen["usercode_body"] = json.loads(req.content)
            return httpx.Response(200, json={"device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": 1})
        if str(req.url) == DEVICE_TOKEN_URL:
            polls["n"] += 1
            if polls["n"] < 3:
                return httpx.Response(403)
            return httpx.Response(200, json={"authorization_code": "code-1", "code_verifier": "ver-1"})
        if str(req.url) == TOKEN_URL:
            seen["exchange"] = parse_qs(req.content.decode())
            return httpx.Response(
                200,
                json={"access_token": access_token(), "refresh_token": "rt-1", "id_token": jwt({"email": "a@b.c"})},
            )
        return httpx.Response(500)

    async def run() -> dict:
        auth = make_auth(tmp_path, handler)
        started = await auth.start_device_login()
        assert started["user_code"] == "ABCD-1234"
        assert auth.state() == "connecting"
        await auth.pending.task  # type: ignore[union-attr]
        return auth.status()

    status = asyncio.run(run())
    assert seen["usercode_body"] == {"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"}
    assert seen["exchange"]["grant_type"] == ["authorization_code"]  # type: ignore[index]
    assert seen["exchange"]["code_verifier"] == ["ver-1"]  # type: ignore[index]
    assert status["state"] == "connected"
    assert status["email"] == "a@b.c"
    assert status["plan"] == "plus"
    assert status["account_id"] == "…456789"
    assert polls["n"] == 3


def test_device_login_reports_poll_failure(tmp_path: Path) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if str(req.url) == USERCODE_URL:
            return httpx.Response(200, json={"device_auth_id": "d", "user_code": "U", "interval": 1})
        return httpx.Response(500)

    async def run() -> CodexAuth:
        auth = make_auth(tmp_path, handler)
        await auth.start_device_login()
        await auth.pending.task  # type: ignore[union-attr]
        return auth

    auth = asyncio.run(run())
    assert auth.state() == "not_connected"
    assert "HTTP 500" in (auth.last_error or "")


def test_refresh_when_expiring_and_keeps_old_refresh_token(tmp_path: Path) -> None:
    calls: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(parse_qs(req.content.decode()))
        return httpx.Response(200, json={"access_token": access_token()})

    auth = make_auth(tmp_path, handler)
    auth.store.save("codex", {"access_token": access_token(exp_in=30), "refresh_token": "rt-old", "source": "device-code"})
    token, info = asyncio.run(auth.access_token())
    assert calls[0]["grant_type"] == ["refresh_token"]
    assert calls[0]["refresh_token"] == ["rt-old"]
    assert info["account_id"] == "acct-123456789"
    assert auth.store.load("codex")["refresh_token"] == "rt-old"  # type: ignore[index]
    # A fresh token is not refreshed again.
    asyncio.run(auth.access_token())
    assert len(calls) == 1


def test_refresh_reused_token_marks_expired(tmp_path: Path) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": "refresh_token_reused"}})

    auth = make_auth(tmp_path, handler)
    auth.store.save("codex", {"access_token": access_token(exp_in=-10), "refresh_token": "rt", "source": "codex-cli"})
    with pytest.raises(ProviderError) as exc:
        asyncio.run(auth.access_token())
    assert exc.value.code == "AUTH_EXPIRED"
    assert "device login" in exc.value.message
    assert auth.state() == "expired"


def test_import_codex_cli_never_modifies_cli_file(tmp_path: Path) -> None:
    cli = tmp_path / "codex"
    cli.mkdir()
    original = json.dumps({"tokens": {"access_token": access_token(), "refresh_token": "rt", "id_token": None}})
    (cli / "auth.json").write_text(original)
    auth = make_auth(tmp_path, lambda r: httpx.Response(500))
    auth.import_codex_cli()
    assert auth.state() == "connected"
    assert auth.status()["source"] == "codex-cli"
    assert (cli / "auth.json").read_text() == original


def test_provider_generate_sends_account_headers_and_decodes(tmp_path: Path) -> None:
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["headers"] = dict(req.headers)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}], "size": "1024x1024"})

    auth = make_auth(tmp_path, lambda r: httpx.Response(500))
    auth.store.save("codex", {"access_token": access_token(), "refresh_token": "rt"})
    provider = CodexProvider(auth, lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    result = asyncio.run(provider.generate(GenerateRequest(prompt="a potion", settings={"aspect_ratio": "16:9"})))
    assert seen["url"] == GENERATIONS_URL
    headers = seen["headers"]
    assert headers["chatgpt-account-id"] == "acct-123456789"  # type: ignore[index]
    assert headers["authorization"].startswith("Bearer ")  # type: ignore[index]
    assert seen["body"]["size"] == "1536x1024"  # type: ignore[index]
    assert result.mime_type == "image/png"
    assert provider.get_capabilities().text_to_image == "supported"
    assert provider.get_capabilities().image_editing == "unknown"


def test_provider_edit_sends_data_urls(tmp_path: Path) -> None:
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}]})

    auth = make_auth(tmp_path, lambda r: httpx.Response(500))
    auth.store.save("codex", {"access_token": access_token(), "refresh_token": "rt"})
    provider = CodexProvider(auth, lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    asyncio.run(provider.edit(GenerateRequest(prompt="x", original_image=png_bytes(), reference_images=[png_bytes()])))
    assert seen["url"] == EDITS_URL
    images = seen["body"]["images"]  # type: ignore[index]
    assert len(images) == 2 and images[0]["image_url"].startswith("data:image/png;base64,")


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (403, {"error": {"message": "no access"}}, "PERMISSION_DENIED"),
        (429, {"error": {"message": "usage limit reached"}}, "QUOTA_EXCEEDED"),
        (404, {}, "PROVIDER_UNAVAILABLE"),
        (200, {"data": []}, "EMPTY_RESULT"),
    ],
)
def test_provider_error_mapping(tmp_path: Path, status: int, body: dict, code: str) -> None:
    auth = make_auth(tmp_path, lambda r: httpx.Response(500))
    auth.store.save("codex", {"access_token": access_token(), "refresh_token": "rt"})
    provider = CodexProvider(auth, lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body))))
    with pytest.raises(ProviderError) as exc:
        asyncio.run(provider.generate(GenerateRequest(prompt="x")))
    assert exc.value.code == code


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(workspace_dir=tmp_path / "ws", credentials_dir=tmp_path / "creds", codex_cli_home=tmp_path / "codex")
    with TestClient(create_app(settings)) as c:
        yield c


def test_auth_status_never_returns_tokens(client: TestClient, tmp_path: Path) -> None:
    cli = tmp_path / "codex"
    cli.mkdir()
    token = access_token()
    (cli / "auth.json").write_text(json.dumps({"tokens": {"access_token": token, "refresh_token": "rt-secret"}}))
    res = client.post("/api/auth/connect", json={"method": "import_codex_cli"}, headers=CSRF)
    assert res.status_code == 200
    assert res.json()["state"] == "connected"
    for r in (res, client.get("/api/auth/status"), client.get("/api/providers")):
        assert token not in r.text and "rt-secret" not in r.text
    assert client.post("/api/auth/disconnect", json={}, headers=CSRF).json()["state"] == "not_connected"


def test_import_without_cli_login_is_a_clear_error(client: TestClient) -> None:
    res = client.post("/api/auth/connect", json={"method": "import_codex_cli"}, headers=CSRF)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "AUTH_REQUIRED"


def test_provider_test_requires_quota_confirmation(client: TestClient) -> None:
    res = client.post("/api/providers/codex/test", json={}, headers=CSRF)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "CONFIRMATION_REQUIRED"
