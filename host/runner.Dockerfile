# The image every run container uses. Based on the course's .sandcastle/Dockerfile.
# Add your project's system packages here.
FROM node:22-bookworm

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

# /work is the mount point of each run's workspace volume. A new named volume copies this ownership.
RUN mkdir /work && chown node:node /work

USER node
RUN curl -fsSL https://claude.ai/install.sh | bash && agent-browser install
ENV PATH="/home/node/.local/bin:$PATH"
WORKDIR /work
