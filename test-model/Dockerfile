# A real llama-swap model container, small enough to run in CI.
#
# Packaged the way epodegrid/model-containers packages the production fleet:
# llama-swap in front of llama-server, its config baked in, and the weights as
# an image layer so nothing is fetched at run time. That last property is the
# point — it is what an air-gapped cluster requires, and testing against a
# container that downloads a model at start-up would prove nothing about it.
#
# Qwen3-0.6B was chosen for what it can do rather than only for its size:
# it thinks (so it emits real `reasoning_content`, not just the loading
# banner), it calls tools, and it ships a jinja chat template. A smaller model
# without those would leave the paths that actually broke in production
# untested.
#
# Build (weights must be fetched first — see fetch-weights.sh):
#   ./test-model/fetch-weights.sh
#   docker build -t controldeck/test-model:latest ./test-model
FROM ghcr.io/mostlygeek/llama-swap:cpu

# Weights first. A COPY invalidates its own layer and every layer after it, so
# with the config above this line an edit to the config re-copied 409 MB every
# time — the opposite of the caching this ordering is for.
COPY models/tiny.gguf /models/tiny.gguf

COPY config.yaml /app/config.yaml

EXPOSE 8080
