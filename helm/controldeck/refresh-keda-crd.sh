#!/usr/bin/env bash
# Re-vendors the KEDA subchart and the copy of its CRDs in crds/.
#
# Run after changing the KEDA version in Chart.yaml. See the header of
# crds/keda-crds.yaml for why the copy exists and what it costs.
#
# Needs network access to the KEDA chart repository, so it is a maintenance
# task run where that is available — never part of an air-gapped install, which
# uses what is already committed here.
set -euo pipefail
cd "$(dirname "$0")"

helm repo add kedacore https://kedacore.github.io/charts >/dev/null
helm repo update kedacore >/dev/null
helm dependency update .

chart=$(ls charts/keda-*.tgz | head -1)
echo "vendored: $chart"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Keep the explanatory header; only the definitions below it are regenerated.
sed -n '1,/^# are inert definitions with no operator behind them\.$/p' \
  crds/keda-crds.yaml > "$tmp/header"

# crds.install must be forced on: this chart disables it for the subchart, and
# these rendered definitions are exactly what that disabling replaces.
helm template keda "$chart" --set crds.install=true > "$tmp/rendered"

python3 - "$tmp" > "$tmp/out" <<'PY'
import sys
tmp = sys.argv[1]
docs = open(f"{tmp}/rendered").read().split("\n---\n")
crds = [d.strip() for d in docs if "kind: CustomResourceDefinition" in d]
if not crds:
    raise SystemExit("no CRDs rendered")
sys.stdout.write(open(f"{tmp}/header").read() + "\n---\n".join(crds) + "\n")
PY

# Only replace on a plausible result — a silent truncation here breaks install.
if ! grep -q "name: scaledobjects.keda.sh" "$tmp/out"; then
  echo "extraction failed; leaving the existing CRDs in place" >&2
  exit 1
fi

mv "$tmp/out" crds/keda-crds.yaml
echo "refreshed crds/keda-crds.yaml ($(grep -c '^  name: .*keda\.sh' crds/keda-crds.yaml) CRDs)"
