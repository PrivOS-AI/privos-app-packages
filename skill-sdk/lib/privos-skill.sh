#!/usr/bin/env bash
# privos-skill.sh — PrivOS skill egress helper (sourceable bash module)
#
# Source this file in skill scripts:
#   source "$(dirname "$0")/privos-skill.sh"
#
# Functions:
#   hub_get  <path>
#   hub_post <path> <json-body>
#   hub_put  <path> <json-body>
#   hub_delete <path>
#   egress_request <method> <url> [json-body]
#
# Env required (sandbox):    PRIVOS_SANDBOX_MODE=true, PROXY_TOKEN, PROXY_URL (optional)
# Env required (non-sandbox): PRIVOS_BOT_KEY, PRIVOS_URL

set -euo pipefail

# ── Internal helpers ──────────────────────────────────────────────────────────

_is_sandbox() {
  [[ "${PRIVOS_SANDBOX_MODE:-false}" == "true" ]]
}

_proxy_url() {
  echo "${PROXY_URL:-http://proxy:8557}"
}

_hub_base_url() {
  if _is_sandbox; then
    local host="${PRIVOS_HUB_HOST:?PRIVOS_HUB_HOST is required in sandbox mode}"
    echo "https://${host}"
  else
    echo "${PRIVOS_URL:?PRIVOS_URL is required in non-sandbox mode}"
  fi
}

# Build JSON egress body for proxy — requires jq
_egress_body() {
  local method="$1" url="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    jq -cn --arg url "$url" --arg method "$method" --argjson body "$body" \
      '{ url: $url, method: $method, headers: {}, body: ($body | tostring) }'
  else
    jq -cn --arg url "$url" --arg method "$method" \
      '{ url: $url, method: $method, headers: {} }'
  fi
}

# ── Core egress function ──────────────────────────────────────────────────────

# egress_request <method> <url> [json-body]
# Returns the upstream response body on stdout.
egress_request() {
  local method="${1:?method required}"
  local url="${2:?url required}"
  local body="${3:-}"

  if _is_sandbox; then
    local token="${PROXY_TOKEN:?PROXY_TOKEN is required in sandbox mode}"
    local proxy
    proxy="$(_proxy_url)"
    local egress_json
    egress_json="$(_egress_body "$method" "$url" "$body")"

    curl -fsS \
      -X POST \
      -H "Content-Type: application/json" \
      -H "x-proxy-token: ${token}" \
      -d "${egress_json}" \
      "${proxy}/egress"
  else
    local bot_key="${PRIVOS_BOT_KEY:?PRIVOS_BOT_KEY is required in non-sandbox mode}"
    local curl_args=( -fsS -X "$method" -H "Authorization: Bearer ${bot_key}" )

    if [[ -n "$body" ]]; then
      curl_args+=( -H "Content-Type: application/json" -d "$body" )
    fi

    curl "${curl_args[@]}" "$url"
  fi
}

# ── Hub convenience wrappers ──────────────────────────────────────────────────

# hub_get <path>
hub_get() {
  local path="${1:?path required}"
  local base
  base="$(_hub_base_url)"
  egress_request "GET" "${base}${path}"
}

# hub_post <path> <json-body>
hub_post() {
  local path="${1:?path required}"
  local json_body="${2:?json-body required}"
  local base
  base="$(_hub_base_url)"
  egress_request "POST" "${base}${path}" "$json_body"
}

# hub_put <path> <json-body>
hub_put() {
  local path="${1:?path required}"
  local json_body="${2:?json-body required}"
  local base
  base="$(_hub_base_url)"
  egress_request "PUT" "${base}${path}" "$json_body"
}

# hub_delete <path>
hub_delete() {
  local path="${1:?path required}"
  local base
  base="$(_hub_base_url)"
  egress_request "DELETE" "${base}${path}"
}
