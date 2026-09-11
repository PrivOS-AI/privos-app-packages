"""
privos_skill_test.py — Smoke tests for privos_skill.py

Run: python3 lib/privos_skill_test.py
No external dependencies beyond requests (already required by privos_skill).
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# Allow running from repo root or lib/ directory
sys.path.insert(0, os.path.dirname(__file__))

import privos_skill
from privos_skill import (
    EgressDeniedError,
    ProxyUnreachableError,
    _is_sandbox,
    _proxy_url,
    external,
    hub,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_response(status_code: int, body: str = "") -> MagicMock:
    """Build a mock requests.Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = body
    resp.content = body.encode()
    return resp


class EnvPatch:
    """Context manager to temporarily set env vars."""

    def __init__(self, **kwargs: str | None):
        self._overrides = kwargs
        self._saved: dict[str, str | None] = {}

    def __enter__(self):
        for k, v in self._overrides.items():
            self._saved[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *_):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ── Tests: mode detection ─────────────────────────────────────────────────────

class TestModeDetection(unittest.TestCase):

    def test_is_sandbox_true(self):
        with EnvPatch(PRIVOS_SANDBOX_MODE="true"):
            self.assertTrue(_is_sandbox())

    def test_is_sandbox_false(self):
        with EnvPatch(PRIVOS_SANDBOX_MODE="false"):
            self.assertFalse(_is_sandbox())

    def test_is_sandbox_missing(self):
        with EnvPatch(PRIVOS_SANDBOX_MODE=None):
            self.assertFalse(_is_sandbox())

    def test_proxy_url_default(self):
        with EnvPatch(PROXY_URL=None):
            self.assertEqual(_proxy_url(), "http://proxy:8557")

    def test_proxy_url_custom(self):
        with EnvPatch(PROXY_URL="http://custom:9999"):
            self.assertEqual(_proxy_url(), "http://custom:9999")


# ── Tests: _egress_fetch sandbox ─────────────────────────────────────────────

class TestEgressFetchSandbox(unittest.TestCase):

    def setUp(self):
        self.env = EnvPatch(
            PRIVOS_SANDBOX_MODE="true",
            PROXY_TOKEN="test-token",
            PROXY_URL="http://proxy:8557",
        )
        self.env.__enter__()

    def tearDown(self):
        self.env.__exit__(None, None, None)

    @patch("privos_skill.requests.post")
    def test_posts_to_egress_with_token(self, mock_post: MagicMock):
        mock_post.return_value = make_response(200, '{"ok":true}')
        privos_skill._egress_fetch("https://api.example.com/data", method="GET")

        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args
        # First positional arg is the proxy URL
        self.assertIn("/egress", call_kwargs.args[0] if call_kwargs.args else call_kwargs.kwargs.get("url", ""))
        headers = call_kwargs.kwargs.get("headers", {})
        self.assertEqual(headers.get("x-proxy-token"), "test-token")

    @patch("privos_skill.requests.post")
    def test_body_included_in_egress_payload(self, mock_post: MagicMock):
        mock_post.return_value = make_response(200, '{}')
        privos_skill._egress_fetch(
            "https://api.example.com/",
            method="POST",
            body='{"msg":"hello"}',
        )
        payload = mock_post.call_args.kwargs.get("json", {})
        self.assertEqual(payload["method"], "POST")
        self.assertEqual(payload["url"], "https://api.example.com/")
        self.assertEqual(payload["body"], '{"msg":"hello"}')

    @patch("privos_skill.requests.post")
    def test_raises_egress_denied_on_403(self, mock_post: MagicMock):
        mock_post.return_value = make_response(403, '{"error":"no catalog entry"}')
        with self.assertRaises(EgressDeniedError) as ctx:
            privos_skill._egress_fetch("https://blocked.example.com/")
        self.assertIn("blocked.example.com", str(ctx.exception))

    def test_raises_when_proxy_token_missing(self):
        os.environ.pop("PROXY_TOKEN", None)
        with self.assertRaises(EnvironmentError):
            privos_skill._egress_fetch("https://api.example.com/")


# ── Tests: _egress_fetch non-sandbox ─────────────────────────────────────────

class TestEgressFetchNonSandbox(unittest.TestCase):

    def setUp(self):
        self.env = EnvPatch(PRIVOS_SANDBOX_MODE="false")
        self.env.__enter__()

    def tearDown(self):
        self.env.__exit__(None, None, None)

    @patch("privos_skill.requests.request")
    def test_calls_target_url_directly(self, mock_req: MagicMock):
        mock_req.return_value = make_response(200, "data")
        privos_skill._egress_fetch("https://api.github.com/repos/foo/bar")

        mock_req.assert_called_once()
        kwargs = mock_req.call_args.kwargs
        self.assertEqual(kwargs["url"], "https://api.github.com/repos/foo/bar")


# ── Tests: hub client sandbox ────────────────────────────────────────────────

class TestHubClientSandbox(unittest.TestCase):

    def setUp(self):
        self.env = EnvPatch(
            PRIVOS_SANDBOX_MODE="true",
            PROXY_TOKEN="hub-token",
            PROXY_URL="http://proxy:8557",
            PRIVOS_HUB_HOST="hub.example.com",
        )
        self.env.__enter__()

    def tearDown(self):
        self.env.__exit__(None, None, None)

    @patch("privos_skill.requests.post")
    def test_hub_get_routes_through_egress(self, mock_post: MagicMock):
        mock_post.return_value = make_response(200, '{}')
        hub.get("/api/rooms/123")

        mock_post.assert_called_once()
        payload = mock_post.call_args.kwargs.get("json", {})
        self.assertEqual(payload["url"], "https://hub.example.com/api/rooms/123")
        self.assertEqual(payload["method"], "GET")

    @patch("privos_skill.requests.post")
    def test_hub_post_serializes_json(self, mock_post: MagicMock):
        mock_post.return_value = make_response(201, '{}')
        hub.post("/api/messages", json_body={"text": "hello"})

        payload = mock_post.call_args.kwargs.get("json", {})
        body = json.loads(payload["body"])
        self.assertEqual(body["text"], "hello")


# ── Tests: hub client non-sandbox ────────────────────────────────────────────

class TestHubClientNonSandbox(unittest.TestCase):

    def setUp(self):
        self.env = EnvPatch(
            PRIVOS_SANDBOX_MODE="false",
            PRIVOS_URL="https://privos.example.com",
            PRIVOS_BOT_KEY="bot-secret",
        )
        self.env.__enter__()

    def tearDown(self):
        self.env.__exit__(None, None, None)

    @patch("privos_skill.requests.request")
    def test_hub_get_sends_bearer_header(self, mock_req: MagicMock):
        mock_req.return_value = make_response(200, '{}')
        hub.get("/api/rooms/123")

        kwargs = mock_req.call_args.kwargs
        self.assertEqual(kwargs["url"], "https://privos.example.com/api/rooms/123")
        self.assertEqual(kwargs["headers"].get("Authorization"), "Bearer bot-secret")


# ── Tests: external client ───────────────────────────────────────────────────

class TestExternalClientSandbox(unittest.TestCase):

    def setUp(self):
        self.env = EnvPatch(
            PRIVOS_SANDBOX_MODE="true",
            PROXY_TOKEN="ext-token",
            PROXY_URL="http://proxy:8557",
        )
        self.env.__enter__()

    def tearDown(self):
        self.env.__exit__(None, None, None)

    @patch("privos_skill.requests.post")
    def test_external_fetch_routes_through_egress(self, mock_post: MagicMock):
        mock_post.return_value = make_response(200, "data")
        external.fetch("https://api.github.com/repos/foo/bar")

        mock_post.assert_called_once()
        payload = mock_post.call_args.kwargs.get("json", {})
        self.assertEqual(payload["url"], "https://api.github.com/repos/foo/bar")


class TestExternalClientNonSandbox(unittest.TestCase):

    def setUp(self):
        self.env = EnvPatch(PRIVOS_SANDBOX_MODE="false")
        self.env.__enter__()

    def tearDown(self):
        self.env.__exit__(None, None, None)

    @patch("privos_skill.requests.request")
    def test_external_fetch_calls_directly(self, mock_req: MagicMock):
        mock_req.return_value = make_response(200, "data")
        external.fetch("https://api.github.com/repos/foo/bar")

        kwargs = mock_req.call_args.kwargs
        self.assertEqual(kwargs["url"], "https://api.github.com/repos/foo/bar")


# ── Tests: error classes ─────────────────────────────────────────────────────

class TestErrorClasses(unittest.TestCase):

    def test_egress_denied_error_host(self):
        err = EgressDeniedError("api.example.com")
        self.assertEqual(err.host, "api.example.com")
        self.assertIn("api.example.com", str(err))

    def test_proxy_unreachable_error(self):
        cause = ConnectionError("ECONNREFUSED")
        err = ProxyUnreachableError("http://proxy:8557", cause)
        self.assertEqual(err.proxy_url, "http://proxy:8557")
        self.assertIs(err.cause, cause)


# ── Runner ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    unittest.main(verbosity=2)
