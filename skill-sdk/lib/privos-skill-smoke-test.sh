#!/usr/bin/env bash
# privos-skill-smoke-test.sh — Smoke tests for privos-skill.sh
#
# Tests helper functions in isolation using mock curl (no real network).
# Uses a temp file to capture curl args across subshell boundaries.
# Run: bash lib/privos-skill-smoke-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/privos-skill.sh"

PASS=0
FAIL=0

# Temp file to capture curl args (survives subshell $(...) calls)
CURL_ARGS_FILE="$(mktemp)"
trap 'rm -f "$CURL_ARGS_FILE"' EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    (( PASS++ )) || true
  else
    echo "  FAIL: $label"
    echo "        expected: $expected"
    echo "        actual:   $actual"
    (( FAIL++ )) || true
  fi
}

# ── Mock curl — writes all args to temp file, returns mock body ───────────────

curl() {
  # Write each argument on its own line for reliable parsing
  printf '%s\n' "$@" > "$CURL_ARGS_FILE"
  echo '{"ok":true}'
}
export -f curl
export CURL_ARGS_FILE

# ── Test: _is_sandbox() ───────────────────────────────────────────────────────

echo ""
echo "=== _is_sandbox() ==="

PRIVOS_SANDBOX_MODE="true"
if _is_sandbox; then
  echo "  PASS: returns true when PRIVOS_SANDBOX_MODE=true"
  (( PASS++ )) || true
else
  echo "  FAIL: should return true"
  (( FAIL++ )) || true
fi

PRIVOS_SANDBOX_MODE="false"
if ! _is_sandbox; then
  echo "  PASS: returns false when PRIVOS_SANDBOX_MODE=false"
  (( PASS++ )) || true
else
  echo "  FAIL: should return false"
  (( FAIL++ )) || true
fi
unset PRIVOS_SANDBOX_MODE

# ── Test: _proxy_url() ────────────────────────────────────────────────────────

echo ""
echo "=== _proxy_url() ==="

result="$(_proxy_url)"
assert_eq "default proxy URL" "http://proxy:8557" "$result"

PROXY_URL="http://custom-proxy:9999"
result="$(_proxy_url)"
assert_eq "custom PROXY_URL" "http://custom-proxy:9999" "$result"
unset PROXY_URL

# ── Test: egress_request — sandbox mode ──────────────────────────────────────

echo ""
echo "=== egress_request (sandbox mode) ==="

export PRIVOS_SANDBOX_MODE="true"
export PROXY_TOKEN="test-proxy-token"
export PROXY_URL="http://proxy:8557"

result="$(egress_request GET https://api.example.com/data)"

# Verify curl was called with the proxy URL
if grep -qF "http://proxy:8557/egress" "$CURL_ARGS_FILE" 2>/dev/null; then
  echo "  PASS: sandbox routes through proxy /egress"
  (( PASS++ )) || true
else
  echo "  FAIL: sandbox should route through proxy /egress"
  echo "        curl args file contents: $(cat "$CURL_ARGS_FILE" 2>/dev/null)"
  (( FAIL++ )) || true
fi

# Verify x-proxy-token header present
if grep -qF "x-proxy-token: test-proxy-token" "$CURL_ARGS_FILE" 2>/dev/null; then
  echo "  PASS: x-proxy-token header is set"
  (( PASS++ )) || true
else
  echo "  FAIL: x-proxy-token header missing"
  echo "        curl args file contents: $(cat "$CURL_ARGS_FILE" 2>/dev/null)"
  (( FAIL++ )) || true
fi

# Verify result contains mocked response
assert_eq "sandbox response body" '{"ok":true}' "$result"

unset PRIVOS_SANDBOX_MODE PROXY_TOKEN PROXY_URL

# ── Test: egress_request — non-sandbox mode ───────────────────────────────────

echo ""
echo "=== egress_request (non-sandbox mode) ==="

export PRIVOS_SANDBOX_MODE="false"
export PRIVOS_BOT_KEY="my-bot-key"
export PRIVOS_URL="https://hub.example.com"

result="$(egress_request GET https://hub.example.com/api/rooms)"

# Verify direct URL (not proxy)
if grep -qF "https://hub.example.com/api/rooms" "$CURL_ARGS_FILE" 2>/dev/null; then
  echo "  PASS: non-sandbox calls target URL directly"
  (( PASS++ )) || true
else
  echo "  FAIL: non-sandbox should call target URL directly"
  echo "        curl args file contents: $(cat "$CURL_ARGS_FILE" 2>/dev/null)"
  (( FAIL++ )) || true
fi

# Verify Bearer token header
if grep -qF "Authorization: Bearer my-bot-key" "$CURL_ARGS_FILE" 2>/dev/null; then
  echo "  PASS: Authorization: Bearer header is set"
  (( PASS++ )) || true
else
  echo "  FAIL: Authorization: Bearer header missing"
  echo "        curl args file contents: $(cat "$CURL_ARGS_FILE" 2>/dev/null)"
  (( FAIL++ )) || true
fi

unset PRIVOS_SANDBOX_MODE PRIVOS_BOT_KEY PRIVOS_URL

# ── Test: hub_get builds correct URL ─────────────────────────────────────────

echo ""
echo "=== hub_get URL construction ==="

export PRIVOS_SANDBOX_MODE="false"
export PRIVOS_BOT_KEY="key"
export PRIVOS_URL="https://hub.example.com"

hub_get "/api/messages" >/dev/null

if grep -qF "https://hub.example.com/api/messages" "$CURL_ARGS_FILE" 2>/dev/null; then
  echo "  PASS: hub_get constructs correct URL"
  (( PASS++ )) || true
else
  echo "  FAIL: hub_get URL incorrect"
  echo "        curl args file contents: $(cat "$CURL_ARGS_FILE" 2>/dev/null)"
  (( FAIL++ )) || true
fi

unset PRIVOS_SANDBOX_MODE PRIVOS_BOT_KEY PRIVOS_URL

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
