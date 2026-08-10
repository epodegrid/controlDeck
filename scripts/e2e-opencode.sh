#!/usr/bin/env bash
# Drives a real coding agent (opencode) against a running controlDeck.
#
#   ./scripts/e2e-real-model.sh    # leave the stack up, or run it yourself
#   ./scripts/e2e-opencode.sh
#
# Answers the question the SDK tests cannot: whether an actual agent client —
# its own system prompt, its own tool schemas, its own retry policy — can use
# the gateway to read and write files.
#
# Deliberately not in CI. It installs opencode over the network at build time
# and resolves a provider package at run time, neither of which belongs in a
# suite that must work air-gapped. Run it by hand when the request or response
# shape changes.
#
# Requires: docker, and a controlDeck router already serving a tools-capable
# model. Override with ROUTER_PORT / MODEL.
set -euo pipefail
cd "$(dirname "$0")/.."

ROUTER_PORT="${ROUTER_PORT:-4120}"
MODEL="${MODEL:-tiny-instruct}"
IMAGE="controldeck/opencode-test:latest"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -sf -o /dev/null "http://localhost:${ROUTER_PORT}/healthz" || {
  echo "No router on :${ROUTER_PORT}. Start one first — ./scripts/e2e-real-model.sh" >&2
  exit 1
}

echo "==> Building $IMAGE"
docker build -q -t "$IMAGE" ./test-model/opencode >/dev/null

TOKEN=$(curl -s -X POST "http://localhost:${ROUTER_PORT}/dev/token" \
  -H 'content-type: application/json' -d '{"name":"opencode-e2e","team":"platform"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

mkdir -p "$WORK/ws"
printf 'the secret word is platypus\n' > "$WORK/ws/hello.txt"

# host.docker.internal, because the router runs on the host and this does not.
python3 - "$TOKEN" "$ROUTER_PORT" "$MODEL" > "$WORK/opencode.json" <<'PY'
import json, sys
token, port, model = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "$schema": "https://opencode.ai/config.json",
    "provider": {
        "controldeck": {
            # controlDeck speaks the OpenAI wire format, so opencode's generic
            # openai-compatible provider is the right one — no shim needed.
            "npm": "@ai-sdk/openai-compatible",
            "name": "controlDeck",
            "options": {
                "baseURL": f"http://host.docker.internal:{port}/v1",
                "apiKey": token,
            },
            "models": {model: {"name": model}},
        }
    },
    "model": f"controldeck/{model}",
}, indent=2))
PY

opencode_run() {
  docker run --rm --add-host=host.docker.internal:host-gateway \
    -v "$WORK/opencode.json:/home/op/.config/opencode/opencode.json:ro" \
    -v "$WORK/ws:/home/op/ws" \
    "$IMAGE" bash -lc "cd ~/ws && timeout 360 opencode run \"$1\" 2>&1 | tail -15"
}

fail=0

echo
echo "==> Read: can the agent call a tool and use its result?"
out=$(opencode_run "Read hello.txt and tell me the secret word.")
echo "$out"
if echo "$out" | grep -qi "platypus"; then
  echo "    PASS — tool call reached the model and its result came back"
else
  echo "    FAIL — the agent never got the file contents" >&2
  fail=1
fi

echo
echo "==> Write: does a tool call actually change the filesystem?"
rm -f "$WORK/ws/notes.md"
out=$(opencode_run "Create a file called notes.md containing exactly the line: hello from opencode")
echo "$out"
if [ -f "$WORK/ws/notes.md" ] && grep -qi "hello from opencode" "$WORK/ws/notes.md"; then
  echo "    PASS — notes.md written: $(cat "$WORK/ws/notes.md")"
else
  echo "    FAIL — no notes.md was written" >&2
  fail=1
fi

echo
[ "$fail" -eq 0 ] && echo "opencode drives controlDeck correctly." || {
  echo "opencode could not drive controlDeck." >&2
  exit 1
}
