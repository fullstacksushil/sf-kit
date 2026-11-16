# The image every run container uses. Based on the course's .sandcastle/Dockerfile.
# Add your project's system packages here.
FROM node:26-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git curl jq ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# agent-browser drives a real browser: the agents take UI screenshots with it, and the prototype task needs it.
# Chrome's system libraries: the list `agent-browser install --with-deps` prints. That command calls sudo,
# which this image has no use for, so apt installs the list here. The node user downloads the browser below.
ARG AGENT_BROWSER_VERSION=0.27.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 \
    libxi6 libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 \
    libxrender1 libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 \
    libxkbcommon0 libatspi2.0-0 libcups2 libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g agent-browser@${AGENT_BROWSER_VERSION}

# rtk shortens the output of shell commands (git, npm, grep, ls) before the agent reads it, through a Claude Code
# hook that orchestrator/src/docker.ts adds. The Apache-2.0 edition: the hook and the filters, no engine.
# A new version: update the three values from the release's checksums.txt.
# The image's own architecture picks the download, so the image builds on amd64 (EC2) and arm64 (a Mac mini VM).
ARG RTK_VERSION=1.2.0
ARG RTK_SHA256_AMD64=a28407dc13038bdc9c2a1f5a047b0c636e0c1d495b15523576e2adb992a06a17
ARG RTK_SHA256_ARM64=9786c61dbbea704e1468ee7060930d3b45b67f79ba2babfb73463e85340628d9
RUN case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64 sum="${RTK_SHA256_AMD64}" ;; \
      arm64) arch=aarch64 sum="${RTK_SHA256_ARM64}" ;; \
      *) echo "rtk: no build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /tmp/rtk.tgz "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-oss-${arch}-unknown-linux-musl.tar.gz" \
  && echo "${sum}  /tmp/rtk.tgz" | sha256sum -c - \
  && tar xzf /tmp/rtk.tgz -C /usr/local/bin rtk && rm /tmp/rtk.tgz
# rtk looks for the hook that `rtk init -g` writes. docker.ts adds the hook its own way, so rtk would tell the agent,
# in the output of its first command, that no hook is installed.
ENV RTK_SUPPRESS_HOOK_WARNING=1

# /work is the mount point of each run's workspace volume. A new named volume copies this ownership.
RUN mkdir /work && chown node:node /work

USER node
RUN curl -fsSL https://claude.ai/install.sh | bash && agent-browser install
ENV PATH="/home/node/.local/bin:$PATH"
WORKDIR /work
