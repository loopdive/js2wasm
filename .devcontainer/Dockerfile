FROM node:25

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  tmux \
  dtach \
  locales \
  openssh-server \
  && locale-gen en_US.UTF-8 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV TERM=xterm-256color

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

COPY .tmux.conf /home/node/.tmux.conf
RUN chown node:node /home/node/.tmux.conf

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Install Claude
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} pnpm

# Copy and set up firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  echo "node ALL=(root) NOPASSWD: /usr/sbin/sshd" >> /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall

# Configure sshd
RUN mkdir -p /var/run/sshd && \
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
  sed -i 's/^#\?Port .*/Port 2222/' /etc/ssh/sshd_config

# Set up authorized_keys for the node user
RUN mkdir -p /home/node/.ssh && \
  echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILMHAw2zZFdfHrwm1rMkZwnbyyxwrpAFBVqdoNKy+vxL thomas@loopdive" > /home/node/.ssh/authorized_keys && \
  echo "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFcvGGPtofV8AJzI504ynCSq2/zTzXojlNavftdhVtu196tJ6Oo3A1lm8PpK2ijHRhrJAoJ4rrMVcTnolO5Guac=" >> /home/node/.ssh/authorized_keys && \
  chmod 700 /home/node/.ssh && \
  chmod 600 /home/node/.ssh/authorized_keys && \
  chown -R node:node /home/node/.ssh

# Auto-attach/create tmux session on SSH login
RUN echo 'if [ -n "$SSH_CONNECTION" ] && [ -z "$TMUX" ] && [ -t 0 ]; then tmux ls 2>/dev/null; fi' >> /home/node/.bashrc

# Install ttyd for web-based terminal access (phone/remote)
RUN wget -q "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.$(uname -m)" -O /usr/local/bin/ttyd && \
  chmod +x /usr/local/bin/ttyd

USER node
