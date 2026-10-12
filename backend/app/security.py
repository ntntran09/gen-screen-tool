"""Local-only request guards (spec §26.1): Host/Origin checks and CSRF header on mutations."""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .config import Settings

CSRF_HEADER = "x-nodecanvas-csrf"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class LocalGuardMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, settings: Settings) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self.settings = settings

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        host = request.headers.get("host", "")
        if host not in self.settings.allowed_hosts:
            return _error(403, "INVALID_HOST", "Requests must target the local backend host.")

        origin = request.headers.get("origin")
        if origin is not None and origin not in self.settings.frontend_origins:
            return _error(403, "INVALID_ORIGIN", "Origin is not allowed.")

        # A custom header cannot be sent cross-site without a CORS preflight, which the
        # CORS policy only grants to the configured frontend origins.
        if request.method not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != "1":
            return _error(403, "CSRF_REJECTED", "Missing CSRF header.")

        return await call_next(request)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})
