# A real agent client, for checking that controlDeck works with one.
#
# The SDK-driven loop in server/test/agent-loop.test.ts asserts the protocol
# and is what CI runs. This is the other half of the question: whether an
# actual coding agent — with its own system prompt, its own tool schemas and
# its own retry behaviour — can drive the gateway. It found things the SDK
# tests did not, notably that opencode sends ~7.2k tokens of prompt and tools
# before the user has typed anything.
#
# Not part of CI: it installs opencode from the network at build time and
# resolves an npm provider package at run time, neither of which belongs in a
# suite that has to work air-gapped.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates git openssh-client sudo bash jq iputils-ping \
  && rm -rf /var/lib/apt/lists/*

# Runs as a non-root user: the agent executes shell commands it decides on,
# and the blast radius should be a container user with a workspace.
RUN useradd -m -s /bin/bash op \
  && echo "op ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/op \
  && chmod 0440 /etc/sudoers.d/op

USER op
WORKDIR /home/op
ENV HOME=/home/op

RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH=/home/op/.opencode/bin:$PATH
