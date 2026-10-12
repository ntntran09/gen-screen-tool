"""NodeCanvas AI local backend."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse

from .config import Settings
from .db import migrate
from .generation.engine import GenerationEngine
from .providers import build_registry
from .routers import assets, auth, generations, projects, providers
from .security import CSRF_HEADER, LocalGuardMiddleware


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
        settings.ensure_dirs()
        migrate(settings.database_path, settings.workspace_dir / "backups")
        app.state.engine.start()
        yield
        await app.state.engine.stop()
        for provider in app.state.providers.list():
            auth = getattr(provider, "auth", None)
            if auth is not None:
                auth.cancel_login()

    app = FastAPI(title="NodeCanvas AI", lifespan=lifespan)
    app.state.settings = settings
    app.state.providers = build_registry(settings)
    # The registry is looked up per task so tests (and future provider settings) can swap it.
    app.state.engine = GenerationEngine(settings, lambda: app.state.providers)

    # The last-added middleware runs first: CORS wraps the guard so preflights get CORS headers.
    app.add_middleware(LocalGuardMiddleware, settings=settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.frontend_origins),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["content-type", CSRF_HEADER],
    )

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
        return JSONResponse(status_code=exc.status_code, content={"error": detail})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "INVALID_INPUT", "message": "Invalid request.", "details": jsonable_encoder(
                # `ctx` can hold raw exception objects that aren't JSON-serialisable.
                [{k: v for k, v in e.items() if k != "ctx"} for e in exc.errors()]
            )}},
        )

    @app.get("/", include_in_schema=False)
    def root() -> RedirectResponse:
        # The backend has no UI of its own; send people who open it directly to the app.
        return RedirectResponse(settings.frontend_origins[0] if settings.frontend_origins else "/docs")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(projects.router)
    app.include_router(auth.router)
    app.include_router(assets.router)
    app.include_router(providers.router)
    app.include_router(generations.router)
    return app


app = create_app()
