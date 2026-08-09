#!/usr/bin/env bash
# Read-only diagnosis of why a deployed controlDeck fleet is not autoscaling.
#
#   ./scripts/diagnose-keda.sh <namespace> [model-id]
#
# Every check here is one that fails *silently* in a cluster: the ScaledObject
# looks healthy, the router looks healthy, and nothing scales. They are ordered
# so the first FAIL is the cause — later checks assume the earlier ones passed.
#
# Changes nothing. Safe against production.
set -uo pipefail

NS="${1:-}"
MODEL="${2:-}"
if [ -z "$NS" ]; then
  echo "usage: $0 <namespace> [model-id]" >&2
  exit 2
fi

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
info() { printf '        %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
step "1. ScaledObjects exist"
# ---------------------------------------------------------------------------
sos=$(kubectl -n "$NS" get scaledobject -o name 2>/dev/null)
if [ -z "$sos" ]; then
  fail "no ScaledObjects in namespace $NS"
  info "The chart creates one per model that owns a workload. If models are"
  info "declared but no ScaledObject exists, the CRD was missing at install."
  exit 1
fi
pass "$(echo "$sos" | wc -l | tr -d ' ') ScaledObject(s)"
[ -z "$MODEL" ] && MODEL=$(echo "$sos" | head -1 | sed 's|scaledobject.keda.sh/||; s|-scaledobject$||')
info "diagnosing model: $MODEL"

# ---------------------------------------------------------------------------
step "2. KEDA created an HPA for it"
# ---------------------------------------------------------------------------
# This is the decisive one. KEDA reconciles a ScaledObject by creating an HPA;
# no HPA means the operator never processed it at all, which is a different
# problem from a metric it cannot read.
hpa=$(kubectl -n "$NS" get hpa "keda-hpa-${MODEL}-scaledobject" -o json 2>/dev/null)
if [ -z "$hpa" ]; then
  fail "no HPA for ${MODEL}-scaledobject — KEDA is not reconciling it"

  step "  2a. Is KEDA scoped to specific namespaces?"
  # The usual cause on a shared cluster, and completely silent: a KEDA
  # installed with watchNamespace set ignores every other namespace. The
  # ScaledObject sits there looking fine, with no status and no HPA.
  found=0
  for kns in $(kubectl get deploy -A -l app.kubernetes.io/name=keda-operator \
                 -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' 2>/dev/null | sort -u); do
    found=1
    watch=$(kubectl -n "$kns" get deploy keda-operator \
      -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="WATCH_NAMESPACE")].value}' 2>/dev/null)
    if [ -z "$watch" ]; then
      pass "keda-operator in '$kns' watches all namespaces"
    elif [ "$watch" = "$NS" ]; then
      pass "keda-operator in '$kns' watches '$watch'"
    else
      fail "keda-operator in '$kns' watches only '$watch' — not '$NS'"
      info "Reinstall KEDA without watchNamespace, or install controlDeck into"
      info "'$watch', or run the chart's own KEDA with keda.enabled=true."
    fi
  done
  [ "$found" = 0 ] && fail "no keda-operator Deployment found in any namespace"

  step "  2b. Operator log, last errors"
  kns=$(kubectl get deploy -A -l app.kubernetes.io/name=keda-operator \
          -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null)
  if [ -n "$kns" ]; then
    kubectl -n "$kns" logs deploy/keda-operator --tail=200 2>/dev/null \
      | grep -iE "error|forbidden|denied|$MODEL" | tail -8 | sed 's/^/        /' \
      || info "(no matching lines)"
  fi
  exit 1
fi
pass "HPA exists"

desired=$(kubectl -n "$NS" get hpa "keda-hpa-${MODEL}-scaledobject" \
            -o jsonpath='{.status.desiredReplicas}' 2>/dev/null)
current=$(kubectl -n "$NS" get hpa "keda-hpa-${MODEL}-scaledobject" \
            -o jsonpath='{.status.currentMetrics[0].external.current.value}' 2>/dev/null)
info "desiredReplicas=${desired:-?}  currentMetricValue=${current:-none yet}"

# ---------------------------------------------------------------------------
step "3. The HPA can actually read the metric"
# ---------------------------------------------------------------------------
# An HPA that cannot fetch its external metric reports it here and then does
# nothing, holding the deployment at minReplicas — which looks identical to
# "there was never any demand".
# jsonpath, not a python heredoc: a heredoc supplies stdin, which would have
# silently replaced the piped HPA json with the script itself — leaving this
# check printing nothing and passing unconditionally, which is exactly what it
# did the first time it ran.
cond=$(kubectl -n "$NS" get hpa "keda-hpa-${MODEL}-scaledobject" -o jsonpath=\
'{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}' 2>/dev/null)
echo "$cond" | sed 's/^/        /'
if echo "$cond" | grep -q "ScalingActive=False"; then
  fail "the HPA cannot read the metric"
  if echo "$cond" | grep -qi "FailedGetExternalMetric\|no metrics returned"; then
    info "Either KEDA cannot reach the router, or the external-metrics"
    info "APIService is served by something else. Checks 4 and 5 tell them apart."
  fi
else
  pass "ScalingActive"
fi

# ---------------------------------------------------------------------------
step "4. The external-metrics APIService is KEDA's"
# ---------------------------------------------------------------------------
# v1beta1.external.metrics.k8s.io is a cluster singleton. A second adapter —
# AKS's KEDA add-on, Azure Monitor, Prometheus adapter — takes it over, and
# every KEDA HPA in the cluster then fails to fetch its metric.
api=$(kubectl get apiservice v1beta1.external.metrics.k8s.io -o json 2>/dev/null)
if [ -z "$api" ]; then
  fail "v1beta1.external.metrics.k8s.io is not registered"
else
  svc=$(kubectl get apiservice v1beta1.external.metrics.k8s.io \
          -o jsonpath='{.spec.service.namespace}/{.spec.service.name}' 2>/dev/null)
  avail=$(kubectl get apiservice v1beta1.external.metrics.k8s.io \
            -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null)
  info "served by: $svc   Available=$avail"
  if echo "$svc" | grep -q "keda"; then
    [ "$avail" = "True" ] && pass "KEDA serves it and it is available" \
                          || fail "KEDA serves it but it is not available"
  else
    fail "served by $svc, not KEDA — KEDA's HPAs cannot fetch metrics"
    info "This is a cluster singleton. Two metrics adapters cannot coexist."
  fi
fi

# ---------------------------------------------------------------------------
step "5. KEDA can reach the router's metric endpoint"
# ---------------------------------------------------------------------------
# Checked first, because an unready router refuses connections and would make
# the reachability probe below report a networking fault that does not exist.
ready=$(kubectl -n "$NS" get pods -l app.kubernetes.io/component=router \
          -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
        | grep -c "^True$")
total=$(kubectl -n "$NS" get pods -l app.kubernetes.io/component=router --no-headers 2>/dev/null | wc -l | tr -d " ")
if [ "${ready:-0}" -eq 0 ]; then
  fail "no router pod is Ready ($ready/$total) — nothing can read the metric"
  info "Fix the router first; everything below would be misleading."
  kubectl -n "$NS" get pods -l app.kubernetes.io/component=router 2>/dev/null | sed "s/^/        /"
  exit 1
fi
pass "router pods Ready: $ready/$total"

url=$(kubectl -n "$NS" get scaledobject "${MODEL}-scaledobject" \
        -o jsonpath='{.spec.triggers[0].metadata.url}' 2>/dev/null)
info "trigger url: $url"
kns=$(kubectl get deploy -A -l app.kubernetes.io/name=keda-operator \
        -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null)
kns="${kns:-$NS}"
out=$(kubectl -n "$kns" run cd-keda-probe-$$ --rm -i --restart=Never --quiet \
        --image=curlimages/curl:8.10.1 --command -- \
        curl -sS --max-time 10 "$url" 2>&1)
if echo "$out" | grep -q "pending_requests"; then
  pass "reachable from KEDA's namespace ($kns)"
  info "$(echo "$out" | head -1)"
  if echo "$out" | grep -q '"pending_requests":0'; then
    warn "the metric is 0 — with no demand, holding at minReplicas is correct"
    info "Drive concurrent traffic and re-run. One in-flight request should"
    info "read 2 (demand 1 + the warm spare)."
  fi
else
  fail "unreachable from namespace $kns"
  info "$(echo "$out" | head -3)"
  info "Usually a NetworkPolicy between namespaces, or a Service name that"
  info "does not resolve from where the operator runs."
fi

step "Done"
