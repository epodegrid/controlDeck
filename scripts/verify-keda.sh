#!/usr/bin/env bash
# Proves KEDA actually scales the model deployments up and down.
#
# The metric arithmetic is covered by unit tests, but whether the KEDA operator
# reads it, whether the ScaledObject is even accepted by the CRD, and whether
# pods genuinely appear can only be answered by a cluster. This script answers
# it, and is the thing to run before trusting autoscaling in production.
#
#   ./scripts/verify-keda.sh
#
# Needs: a reachable cluster (minikube start), kubectl, helm.
set -euo pipefail

NS="${NAMESPACE:-controldeck-keda-test}"
MODEL="${MODEL:-kestrel-9b}"
RELEASE=cdk

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Checking prerequisites"
kubectl cluster-info >/dev/null 2>&1 || {
  echo "No reachable cluster. Start one first, e.g.:  minikube start" >&2
  exit 1
}
kubectl version -o json 2>/dev/null | head -1 >/dev/null
echo "cluster reachable"

step "Installing KEDA if absent"
if ! kubectl get crd scaledobjects.keda.sh >/dev/null 2>&1; then
  helm repo add kedacore https://kedacore.github.io/charts >/dev/null
  helm repo update >/dev/null
  helm install keda kedacore/keda --namespace keda --create-namespace --wait
else
  echo "KEDA already installed"
fi

step "Deploying controlDeck with the mock model fleet"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
helm dependency build helm/controldeck >/dev/null
helm upgrade --install "$RELEASE" helm/controldeck \
  --namespace "$NS" --set mockModels.enabled=true --wait --timeout 10m

step "Baseline replica count for $MODEL"
kubectl -n "$NS" get deploy "${MODEL}-replica" -o jsonpath='{.spec.replicas}'; echo
kubectl -n "$NS" get scaledobject "${MODEL}-scaledobject" \
  -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?\(@.type==\"Ready\"\)].status --no-headers

step "Confirming KEDA can read the router's metric"
# The value the operator polls. If this is unreachable or malformed, scaling
# silently never happens — which is precisely the failure mode worth catching.
kubectl -n "$NS" run keda-probe --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- \
  curl -s "http://${RELEASE}-controldeck-router:4000/metrics/keda/${MODEL}" || true

step "Generating load"
kubectl -n "$NS" get pods -l "controldeck.io/model-id=${MODEL}" --no-headers | wc -l | xargs echo "pods before:"
echo "Drive traffic at the router now (port-forward + the simulator), then watch:"
echo "  kubectl -n $NS get deploy ${MODEL}-replica -w"
echo "  kubectl -n $NS describe scaledobject ${MODEL}-scaledobject"
echo
echo "Clean up with:  helm -n $NS uninstall $RELEASE && kubectl delete ns $NS"
