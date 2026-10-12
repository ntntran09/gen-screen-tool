"""Uniform API errors: {"error": {"code", "message"}} (spec §20.4)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


class ApiError(HTTPException):
    def __init__(self, status_code: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(status_code=status_code, detail={"code": code, "message": message, **extra})
