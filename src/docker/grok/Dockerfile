FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ARG GROK_VERSION=1.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev "@xai-official/grok@${GROK_VERSION}" \
    && grok --version \
    && grok_binary="$(find /root/.grok/bin -maxdepth 1 -type f -name 'grok-*' | head -n 1)" \
    && test -n "$grok_binary" \
    && install -m 0555 "$grok_binary" /usr/local/bin/grok-build \
    && rm -rf /root/.grok \
    && npm cache clean --force

COPY codepet-grok-stdin /usr/local/bin/codepet-grok-stdin
COPY codepet-grok-write /usr/local/bin/codepet-grok-write

RUN sed -i 's/\r$//' /usr/local/bin/codepet-grok-stdin \
    && chmod 0555 /usr/local/bin/codepet-grok-stdin /usr/local/bin/codepet-grok-write \
    && mkdir -p /home/node/.grok /workspace \
    && chown -R node:node /home/node /workspace

ENV HOME=/home/node \
    GROK_HOME=/home/node/.grok \
    NO_COLOR=1

USER node
WORKDIR /workspace
ENTRYPOINT ["grok-build"]
