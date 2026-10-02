# Grid Core

HTTP API for Grid Console — **the heart of the platform**. Accepts deploy
requests, maps them to Grid JSON, runs the CLI add-on (`generate`) + Terraform,
and streams status/logs.

**Self-host:** see [`install/`](./install/) and
[grid-docs → Install](https://github.com/gridplatform/grid-docs/tree/main/docs/install).

```bash
# Docker Compose (default on VMs too)
cp install/.env.example install/.env   # set GRID_AUTH_ADMIN_PASSWORD
docker compose -f install/docker-compose.yml --env-file install/.env up -d --build
bash install/verify.sh

# Or Ubuntu VM one-liner (Compose)
# curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```

## Run (development)

```bash
cd grid-core
cp -n .env.example .env
npm install
npm run dev
```

Listens on `http://localhost:3000` (`PORT`).

## Paths Core owns (injected into CLI)

| Variable | Purpose | Local default |
|----------|---------|----------------|
| `GRID_CONFIG_ROOT` | Desired-state working tree (GitOps checkout) | `./data/desired-state` when `GRID_GITOPS_REPO_URL` is set; else `../demo-infra` |
| `GRID_MODULE_BANK` | `grid-terraform` — **git URL or local path** | `../grid-terraform` |
| `GRID_MODULE_BANK_REF` | Branch/tag when bank is a git URL | `main` |
| `GRID_GITOPS_REPO_URL` | Remote desired-state repo | _(unset)_ |
| `GRID_CLI_ROOT` | CLI package (add-on) | `../grid-cli` |
| `GRID_WORK_DIR` | Terraform workspaces | `./workspaces` |
| `GRID_DATA_DIR` | JSON store | `./data` |
| `GRID_TERRAFORM_BIN` | `terraform` binary | `terraform` |
| `GRID_AUTO_APPROVE` | Apply `-auto-approve` | `true` |

**`demo-infra` is a test fixture only** — not the final customer configuration.
Normal installs: `grid init` → set `GRID_CONFIG_ROOT` to that directory.

## Normal install (not demo)

```bash
mkdir my-infra && cd my-infra
git init
grid init --git --sample          # from grid-cli (npm run grid -- init …)

export GRID_CONFIG_ROOT=$PWD      # point grid-core at THIS repo
# start grid-core with that env

grid generate -c aws/development/vpc/example-vpc.json --config-dir "$GRID_CONFIG_ROOT"
```

`POST /api/v1/deployments` with `{ name, engine, provider, environment, resourceType, config }`.

Terraform engine maps the request to Grid JSON and runs `grid-cli generate` +
Terraform apply against the **module bank from Core env**. Follow with
`GET /api/v1/deployments/:id` and `.../logs`.

**Access model:** console feature flags only hide types in the UI. The API and
CLI do not read those flags — a correct request or Grid JSON still runs if the
module bank and credentials are ready.
