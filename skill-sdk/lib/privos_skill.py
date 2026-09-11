"""
privos_skill.py — PrivOS skill egress helper (importable Python module).

Usage:
    from privos_skill import hub, external

    # Sandbox mode (PRIVOS_SANDBOX_MODE=true):
    #   All requests routed through proxy /egress with x-proxy-token.
    # Non-sandbox mode:
    #   hub.*    → direct requests with Authorization: Bearer
    #   external.fetch() → direct requests (skill supplies own auth)

Dependencies: requests (pip install requests)
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import requests
from requests import Response

# ── Internal helpers ──────────────────────────────────────────────────────────


def _is_sandbox() -> bool:
    return os.environ.get("PRIVOS_SANDBOX_MODE", "false") == "true"


def _proxy_url() -> str:
    return os.environ.get("PROXY_URL", "http://proxy:8557")


def _proxy_token() -> str:
    token = os.environ.get("PROXY_TOKEN", "")
    if _is_sandbox() and not token:
        raise EnvironmentError("PROXY_TOKEN is required in sandbox mode but is not set")
    return token


def _hub_base_url() -> str:
    if _is_sandbox():
        host = os.environ.get("PRIVOS_HUB_HOST", "")
        if not host:
            raise EnvironmentError("PRIVOS_HUB_HOST is required in sandbox mode")
        return f"https://{host}"
    base = os.environ.get("PRIVOS_URL", "")
    if not base:
        raise EnvironmentError("PRIVOS_URL is required in non-sandbox mode")
    return base.rstrip("/")


def _bot_key() -> str:
    key = os.environ.get("PRIVOS_BOT_KEY", "")
    if not _is_sandbox() and not key:
        raise EnvironmentError("PRIVOS_BOT_KEY is required in non-sandbox mode")
    return key


def _egress_fetch(
    url: str,
    method: str = "GET",
    headers: Optional[dict[str, str]] = None,
    body: Optional[str] = None,
) -> Response:
    """Core egress function — routes through proxy in sandbox, direct otherwise."""
    headers = headers or {}

    if _is_sandbox():
        token = _proxy_token()
        payload: dict[str, Any] = {"url": url, "method": method, "headers": headers}
        if body is not None:
            payload["body"] = body
        response = requests.post(
            f"{_proxy_url()}/egress",
            json=payload,
            headers={"x-proxy-token": token},
            timeout=60,
        )
        # 403 from proxy means no catalog entry
        if response.status_code == 403:
            import urllib.parse
            host = urllib.parse.urlparse(url).hostname or url
            raise EgressDeniedError(host)
        return response

    # Non-sandbox: direct request
    req_headers = {**headers}
    if "Authorization" not in req_headers and "authorization" not in req_headers:
        pass  # external.fetch supplies its own auth; hub methods add Bearer below

    req_kwargs: dict[str, Any] = {
        "method": method,
        "url": url,
        "headers": req_headers,
        "timeout": 60,
    }
    if body is not None and method not in ("GET", "HEAD"):
        req_kwargs["data"] = body

    return requests.request(**req_kwargs)


# ── Error classes ─────────────────────────────────────────────────────────────


class EgressDeniedError(Exception):
    """Proxy returned 403: no catalog entry for the target domain."""

    def __init__(self, host: str) -> None:
        self.host = host
        super().__init__(
            f"Egress denied: no catalog entry for host '{host}'. "
            "Add the domain to the project egress catalog."
        )


class ProxyUnreachableError(Exception):
    """Network-level failure reaching the proxy."""

    def __init__(self, proxy_url: str, cause: Exception) -> None:
        self.proxy_url = proxy_url
        self.cause = cause
        super().__init__(f"Proxy unreachable at '{proxy_url}': {cause}")


# ── Hub client ────────────────────────────────────────────────────────────────


class _HubClient:
    """High-level PrivOS hub client."""

    def _request(
        self,
        method: str,
        path: str,
        headers: Optional[dict[str, str]] = None,
        body: Optional[str] = None,
    ) -> Response:
        url = f"{_hub_base_url()}{path}"
        merged: dict[str, str] = {}
        if not _is_sandbox():
            merged["Authorization"] = f"Bearer {_bot_key()}"
        if headers:
            merged.update(headers)
        return _egress_fetch(url, method=method, headers=merged, body=body)

    def get(
        self,
        path: str,
        headers: Optional[dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Response:
        """GET a hub path. Query parameters can be passed via `params` dict."""
        if params:
            path = f"{path}?{urlencode(params)}"
        return self._request("GET", path, headers=headers)

    def post(
        self,
        path: str,
        json_body: Optional[Any] = None,
        body: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Response:
        """POST to a hub path with optional JSON or raw body."""
        extra: dict[str, str] = {}
        raw: Optional[str] = body
        if json_body is not None:
            raw = json.dumps(json_body)
            extra["content-type"] = "application/json"
        return self._request("POST", path, headers={**extra, **(headers or {})}, body=raw)

    def put(
        self,
        path: str,
        json_body: Optional[Any] = None,
        body: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Response:
        """PUT to a hub path."""
        extra: dict[str, str] = {}
        raw: Optional[str] = body
        if json_body is not None:
            raw = json.dumps(json_body)
            extra["content-type"] = "application/json"
        return self._request("PUT", path, headers={**extra, **(headers or {})}, body=raw)

    def delete(self, path: str, headers: Optional[dict[str, str]] = None) -> Response:
        """DELETE a hub path."""
        return self._request("DELETE", path, headers=headers)

    def upload_file(
        self,
        path: str,
        data: bytes,
        content_type: str = "application/octet-stream",
    ) -> Response:
        """
        Upload binary data to a hub files endpoint.
        In sandbox mode: base64-encodes data for /egress string body field.
        In non-sandbox: sends raw bytes with direct requests.
        """
        import base64

        url = f"{_hub_base_url()}{path}"
        if _is_sandbox():
            encoded = base64.b64encode(data).decode("ascii")
            return _egress_fetch(
                url,
                method="PUT",
                headers={"content-type": content_type, "x-content-encoding": "base64"},
                body=encoded,
            )
        # Non-sandbox: direct binary upload
        return requests.put(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {_bot_key()}",
                "content-type": content_type,
            },
            timeout=120,
        )

    def _post_multipart(self, path: str, parts: list[tuple[str, str, Optional[bytes], Optional[str]]]) -> Response:
        """
        Build & POST a multipart/form-data body to a hub path. No
        `requests_toolbelt` dependency — stdlib only.

        `parts` is a list of (name, filename_or_empty, bytes_or_none, content_type).
        - For text form fields: (name, "", None, value-as-bytes-via-content_type-trick? no)
          Use this form: ("channelId", "", None, None) and pass the text value as
          the bytes argument: ("channelId", "", b"ABC123", None).
        - For file fields:    ("files", "name.md", b"...", "text/markdown").
        """
        import base64
        import uuid

        boundary = f"----PrivosSkillBoundary{uuid.uuid4().hex}"
        chunks: list[bytes] = []
        for field_name, filename, data, ctype in parts:
            chunks.append(f"--{boundary}\r\n".encode("ascii"))
            if filename:
                chunks.append(
                    f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode("utf-8")
                )
                chunks.append(f"Content-Type: {ctype or 'application/octet-stream'}\r\n\r\n".encode("ascii"))
            else:
                chunks.append(
                    f'Content-Disposition: form-data; name="{field_name}"\r\n\r\n'.encode("utf-8")
                )
            chunks.append(data or b"")
            chunks.append(b"\r\n")
        chunks.append(f"--{boundary}--\r\n".encode("ascii"))
        body = b"".join(chunks)

        url = f"{_hub_base_url()}{path}"
        ct_header = f"multipart/form-data; boundary={boundary}"

        if _is_sandbox():
            encoded = base64.b64encode(body).decode("ascii")
            return _egress_fetch(
                url,
                method="POST",
                headers={"content-type": ct_header, "x-content-encoding": "base64"},
                body=encoded,
            )

        return requests.post(
            url,
            data=body,
            headers={"Authorization": f"Bearer {_bot_key()}", "content-type": ct_header},
            timeout=120,
        )

    def upload_room_file(
        self,
        room_id: str,
        file_path: str,
        file_name: Optional[str] = None,
        content_type: Optional[str] = None,
        description: Optional[str] = None,
        upload_only: bool = True,
    ) -> Response:
        """
        Upload a file to a Rocket.Chat-style room via POST /api/v1/rooms.upload/{rid}.

        Note: this endpoint stores the file in the chat-message attachments
        collection (NOT File Management). The resulting fileId is not viewable
        by item DOCUMENT/FILE field renderers — use `upload_to_file_management`
        for files that need to render through `/api/v1/file-management.files/...`.
        """
        import mimetypes
        import os

        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        name = file_name or os.path.basename(file_path)
        mime = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        with open(file_path, "rb") as fh:
            file_bytes = fh.read()

        parts: list[tuple[str, str, Optional[bytes], Optional[str]]] = [("file", name, file_bytes, mime)]
        if description is not None:
            parts.append(("description", "", description.encode("utf-8"), None))
        if upload_only:
            parts.append(("uploadOnly", "", b"true", None))

        return self._post_multipart(f"/api/v1/rooms.upload/{room_id}", parts)

    def get_or_create_uploads_folder(self, channel_id: str) -> str:
        """
        Resolve (or create) the root-level "Uploads" folder for a channel and
        return its `_id`. Mirrors the client behaviour in
        `fileManagementClient.getOrCreateUploadsFolder` so the file-management
        viewer treats SDK-uploaded files identically to UI uploads.
        """
        resp = self.get(
            f"/api/v1/file-management.folders.channel/{channel_id}",
            params={"count": 200},
        )
        if resp.status_code < 400:
            try:
                payload = resp.json()
            except Exception:
                payload = {}
            for folder in (payload.get("folders") or []):
                if folder.get("name") == "Uploads" and not folder.get("father"):
                    return str(folder.get("_id") or "")

        create_resp = self.post(
            "/api/v1/file-management.folders.create",
            json_body={"name": "Uploads", "channelId": channel_id},
        )
        if create_resp.status_code >= 400:
            raise RuntimeError(
                f"Failed to create Uploads folder: HTTP {create_resp.status_code} {create_resp.text[:200]}"
            )
        try:
            data = create_resp.json()
        except Exception:
            data = {}
        folder_id = ((data.get("folder") or {}).get("_id")) or (data.get("_id"))
        if not folder_id:
            raise RuntimeError(f"Create-folder response missing _id: {data}")
        return str(folder_id)

    def upload_to_file_management(
        self,
        channel_id: str,
        file_path: str,
        folder_id: Optional[str] = None,
        file_name: Optional[str] = None,
        content_type: Optional[str] = None,
        duplicate_action: str = "keep_both",
    ) -> Response:
        """
        Upload a file via POST /api/v1/file-management.files.upload.

        Auto-resolves `folder_id` to the channel's root-level "Uploads" folder
        when not provided — matches UI behaviour and ensures the resulting
        fileId is viewable through the standard file-management viewer.
        """
        import mimetypes
        import os

        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        if not folder_id:
            folder_id = self.get_or_create_uploads_folder(channel_id)

        name = file_name or os.path.basename(file_path)
        mime = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        with open(file_path, "rb") as fh:
            file_bytes = fh.read()

        parts: list[tuple[str, str, Optional[bytes], Optional[str]]] = [
            ("files", name, file_bytes, mime),
            ("channelId", "", channel_id.encode("utf-8"), None),
            ("folderId", "", folder_id.encode("utf-8"), None),
            ("duplicateAction", "", duplicate_action.encode("utf-8"), None),
        ]
        return self._post_multipart("/api/v1/file-management.files.upload", parts)


# ── External client ───────────────────────────────────────────────────────────


class _ExternalClient:
    """Egress wrapper for non-hub external URLs."""

    def fetch(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[dict[str, str]] = None,
        body: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Response:
        """
        Fetch any external URL via the configured egress path.

        Sandbox:     routed through proxy /egress (catalog validates domain).
        Non-sandbox: direct fetch (skill supplies its own auth in headers).

        `params` dict is URL-encoded and appended as query string.
        """
        if params:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{urlencode(params)}"
        return _egress_fetch(url, method=method, headers=headers or {}, body=body)


# ── Public singletons ─────────────────────────────────────────────────────────

hub = _HubClient()
external = _ExternalClient()

__all__ = [
    "hub",
    "external",
    "EgressDeniedError",
    "ProxyUnreachableError",
    "_is_sandbox",
    "_proxy_url",
]
