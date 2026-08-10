#!/usr/bin/env bash
# Fetches the test model's weights, once, into test-model/models/.
#
# Kept out of the image build so the download is cacheable and so the build
# itself needs no network — the same property the production images have, and
# the reason the air-gapped install works at all.
#
# Pinned by digest, not by tag: "latest Q4_0" changing underneath the test
# suite would turn a model update into a mystery test failure.
set -euo pipefail
cd "$(dirname "$0")"

REPO="ggml-org/Qwen3-0.6B-GGUF"
FILE="Qwen3-0.6B-Q4_0.gguf"
SHA256="da2572f16c06133561ce56accaa822216f2391ef4d37fba427801cd6736417d4"
URL="https://huggingface.co/${REPO}/resolve/main/${FILE}"

mkdir -p models
OUT="models/tiny.gguf"

if [ -f "$OUT" ] && echo "${SHA256}  ${OUT}" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "weights already present and verified"
  exit 0
fi

echo "downloading ${FILE} (~409 MB) from ${REPO}"
curl -fL --progress-bar -o "${OUT}.part" "$URL"

# Verified before it is moved into place, so an interrupted or corrupted
# download can never be picked up by a later build as though it were good.
if ! echo "${SHA256}  ${OUT}.part" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "checksum mismatch — refusing to use this download" >&2
  echo "expected ${SHA256}" >&2
  echo "got      $(shasum -a 256 "${OUT}.part" | cut -d' ' -f1)" >&2
  rm -f "${OUT}.part"
  exit 1
fi

mv "${OUT}.part" "$OUT"
echo "weights verified: $OUT"
