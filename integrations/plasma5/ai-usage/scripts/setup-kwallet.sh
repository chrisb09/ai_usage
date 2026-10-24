#!/usr/bin/env bash
set -euo pipefail

if ! command -v secret-tool >/dev/null 2>&1; then
    echo "secret-tool not found. Install libsecret-tools (or use a custom credential command)." >&2
    exit 1
fi

if [ -n "${AI_USAGE_BASIC:-}" ]; then
    basic="$AI_USAGE_BASIC"
elif [ -n "${AI_USAGE_USER:-}" ] && [ -n "${AI_USAGE_PASS:-}" ]; then
    basic="$(printf '%s' "$AI_USAGE_USER:$AI_USAGE_PASS" | base64 -w0)"
else
    read -r -p "Dashboard username: " username
    read -r -s -p "Dashboard password: " password
    echo
    if [ -z "$username" ] || [ -z "$password" ]; then
        echo "Username and password must not be empty." >&2
        exit 1
    fi
    basic="$(printf '%s' "$username:$password" | base64 -w0)"
    unset username password
fi

printf '%s' "$basic" | secret-tool store \
    --label="AI Usage dashboard" \
    service ai-usage \
    entry basic

echo "Stored the Basic credential in the Secret Service (KWallet on Plasma)."
echo
echo "Test it with:"
echo "  secret-tool lookup service ai-usage entry basic | head -c 8; echo"
echo
echo "Then reload the AI Usage widget (right-click -> Reload credentials)."
