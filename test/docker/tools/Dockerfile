# Reproducible container for QA of the pi-async extension.
#
# Build:  docker build -t pi-async-test:latest /root/pi-async-docker
# Run:    see /root/pi-async-docker/run-container.sh

FROM node:22-bookworm

ARG PI_VERSION=1.2.0
ARG ANY_ENDPOINT_VERSION=0.1.3

# Harness tooling. These MUST be baked in: a fresh container from this image is
# created for every QA run, so anything installed into a live container is lost.
#   tmux            drives the TUI deterministically and captures ANSI
#   python3-pil     renders captured ANSI to PNG (IM's pango coder drops colors)
#   fonts           box-drawing / CJK legibility
#   Xvfb+xterm      real X terminal, for pixel-true screenshots
#   ripgrep+fd-find pi shells out to rg/fd for file search. Without them pi
#                   downloads static binaries from GitHub on EVERY session
#                   start into ~/.pi/agent/bin (10s + network flake, and it
#                   lands in the container layer so a rebuild loses it).
#                   getToolPath() checks PATH, and accepts `fdfind` as an fd
#                   alias, so the Debian packages satisfy it as-is.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      tmux python3-pil fonts-dejavu-core fonts-noto-cjk \
      xvfb xterm xdotool imagemagick \
      ripgrep fd-find \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# pi-coding-agent host binary (pi-async declares it as a peer dependency)
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION} \
 && npm cache clean --force

# Provider package that registers the any-endpoint provider
RUN pi install npm:pi-any-endpoint@${ANY_ENDPOINT_VERSION}

# The extension under test lives at /mnt/pi-async (mounted at run time).
RUN mkdir -p /mnt/pi-async \
 && pi install /mnt/pi-async || true

# Without this tmux prints a warning banner into every capture and modified
# Enter keys misbehave.
RUN echo "set -g extended-keys on" > /root/.tmux.conf

WORKDIR /root
CMD ["sleep", "infinity"]
