# syntax=docker/dockerfile:1

# grid-core + grid-cli + Terraform — control plane image
FROM node:20-bookworm-slim

ARG TERRAFORM_VERSION=1.9.8
ARG GRID_CLI_REPO=https://github.com/gridplatform/grid-cli.git
ARG GRID_CLI_REF=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) TF_ARCH=amd64 ;; \
       arm64) TF_ARCH=arm64 ;; \
       *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${TF_ARCH}.zip" \
       -o /tmp/terraform.zip \
  && unzip /tmp/terraform.zip -d /usr/local/bin \
  && rm /tmp/terraform.zip \
  && terraform version

WORKDIR /opt/grid

# CLI (invoked by core for generate/plan/apply/destroy)
RUN git clone --depth 1 --branch "${GRID_CLI_REF}" "${GRID_CLI_REPO}" /opt/grid/grid-cli \
  && cd /opt/grid/grid-cli \
  && npm ci \
  && npm run build \
  && npm prune --omit=dev

# Core API
COPY package.json package-lock.json* ./grid-core/
WORKDIR /opt/grid/grid-core
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY install ./install
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    GRID_APP_ENV=production \
    PORT=3000 \
    GRID_CLI_ROOT=/opt/grid/grid-cli \
    GRID_DATA_DIR=/var/lib/grid/data \
    GRID_WORK_DIR=/var/lib/grid/workspaces \
    GRID_CONFIG_ROOT=/var/lib/grid/desired-state \
    GRID_MODULE_BANK=https://github.com/gridplatform/grid-terraform.git \
    GRID_MODULE_BANK_REF=v0.1.0 \
    GRID_TERRAFORM_BIN=terraform

RUN mkdir -p /var/lib/grid/data /var/lib/grid/workspaces /var/lib/grid/desired-state

EXPOSE 3000
VOLUME ["/var/lib/grid/data", "/var/lib/grid/workspaces", "/var/lib/grid/desired-state"]

WORKDIR /opt/grid/grid-core
CMD ["node", "dist/index.js"]
