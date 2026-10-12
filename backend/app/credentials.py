"""Credential storage kept outside every project folder (spec §19.3, §22.1).

On Windows the file is encrypted with DPAPI (bound to the current Windows user).
Elsewhere it falls back to a 0600 plain JSON file.
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

_DPAPI_MAGIC = b"NCDPAPI1"


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes:
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    # CRYPTPROTECT_UI_FORBIDDEN = 0x1
    if not fn(ctypes.byref(blob_in), None, None, None, None, 0x1, ctypes.byref(blob_out)):
        raise OSError("DPAPI operation failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


class CredentialStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def _path(self, name: str) -> Path:
        if not name.isidentifier():
            raise ValueError("invalid credential name")
        return self.directory / f"{name}.cred"

    def load(self, name: str) -> dict[str, Any] | None:
        path = self._path(name)
        if not path.exists():
            return None
        raw = path.read_bytes()
        if raw.startswith(_DPAPI_MAGIC):
            raw = _dpapi(raw[len(_DPAPI_MAGIC) :], protect=False)
        return json.loads(raw.decode("utf-8"))

    def save(self, name: str, value: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        data = json.dumps(value).encode("utf-8")
        if sys.platform == "win32":
            data = _DPAPI_MAGIC + _dpapi(data, protect=True)
        path = self._path(name)
        fd, tmp = tempfile.mkstemp(dir=self.directory, prefix=f".{name}-", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def delete(self, name: str) -> None:
        self._path(name).unlink(missing_ok=True)
