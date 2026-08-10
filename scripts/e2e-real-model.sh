#!/usr/bin/env bash
# Integration suite against a real model, through the real gateway.
#
#   ./scripts/e2e-real-model.sh
#
# Brings up a llama-swap container with real weights, Postgres, and the router,
# then runs the two suites that are skipped without them:
#
#   real-model.test.ts   the adapter against the container directly
#   agent-loop.test.ts   the official OpenAI SDK driving a tool loop through
#                        the router, with tools that really read, write and
#                        execute in a temp workspace
#
# These exist because fakes could not have found the bugs they cover. A stub
# echoes the shape you already believed in, and every one of these paths broke
# exactly where that belief was wrong — most expensively when the router
# forwarded `tools` upstream and then dropped `tool_calls` coming back, which
# left every agent client looking at a model that refused to use its tools.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="controldeck/test-model:latest"
NAME="controldeck-test-model"
MODEL_PORT="${TEST_MODEL_PORT:-8130}"
ROUTER_PORT="${TEST_ROUTER_PORT:-4120}"
MODEL_ID="tiny"

ROUTER_PID=""
cleanup() {
  [ -n "$ROUTER_PID" ] && kill "$ROUTER_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() { # url, seconds, label
  for _ in $(seq 1 "$2"); do
    curl -sf -o /dev/null "$1" 2>/dev/null && return 0
    sleep 1
  done
  echo "timed out waiting for $3 at $1" >&2
  return 1
}

echo "==> Fetching weights (cached after the first run)"
./test-model/fetch-weights.sh

echo "==> Building $IMAGE"
docker build -q -t "$IMAGE" ./test-model >/dev/null

echo "==> Starting the model container on :$MODEL_PORT"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "${MODEL_PORT}:8080" "$IMAGE" >/dev/null
# Note this proves nothing about the *model* being ready: llama-swap's /health
# reports its own process and answers 200 with no weights loaded. The model
# loads on the first request, which is what the first test pays for.
wait_for "http://localhost:${MODEL_PORT}/health" 90 "llama-swap" || {
  docker logs "$NAME" 2>&1 | tail -20 >&2; exit 1;
}

echo "==> Starting Postgres"
docker compose up -d postgres >/dev/null
for _ in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U controldeck >/dev/null 2>&1 && break
  sleep 1
done
docker compose exec -T postgres pg_isready -U controldeck >/dev/null 2>&1 || {
  echo "Postgres did not become ready. Disk full is the usual cause:" >&2
  echo "  docker system df   # build cache grows fast when iterating on images" >&2
  exit 1
}

echo "==> Registering the model"
docker compose exec -T postgres psql -U controldeck -d controldeck -q -c "
INSERT INTO model_registry
  (id,name,class_label,model_class,capabilities,min_replicas,max_replicas,
   system_prompt,cost_value,cost_basis,endpoint_url,upstream_model,port,first_token_timeout_ms)
VALUES ('${MODEL_ID}','Tiny','Test','fast','{chat,tools}',1,1,'',0.001,'per_1k_tokens',
        'http://localhost:${MODEL_PORT}','${MODEL_ID}',8080,600000)
ON CONFLICT (id) DO UPDATE SET
  endpoint_url=EXCLUDED.endpoint_url,
  upstream_model=EXCLUDED.upstream_model,
  capabilities=EXCLUDED.capabilities;" >/dev/null

echo "==> Starting the router on :$ROUTER_PORT"
(cd server && SIM_MODE=true MODEL_BACKEND=http PORT="$ROUTER_PORT" \
   npx tsx --env-file-if-exists=.env src/index.ts > /tmp/e2e-router.log 2>&1) &
ROUTER_PID=$!
wait_for "http://localhost:${ROUTER_PORT}/healthz" 60 "router" || {
  tail -20 /tmp/e2e-router.log >&2; exit 1;
}

TOKEN=$(curl -s -X POST "http://localhost:${ROUTER_PORT}/dev/token" \
  -H 'content-type: application/json' \
  -d '{"name":"E2E","team":"platform"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

echo "==> Running the suites"
cd server
REAL_MODEL_URL="http://localhost:${MODEL_PORT}" \
REAL_GATEWAY_URL="http://localhost:${ROUTER_PORT}" \
REAL_GATEWAY_TOKEN="$TOKEN" \
REAL_GATEWAY_MODEL="$MODEL_ID" \
  npx vitest run --config vitest.real-model.config.ts
