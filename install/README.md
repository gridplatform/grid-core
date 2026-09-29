# Install artifacts (self-host)

Scripts and Compose for running Grid on a VM or with Docker. Narrative guides:

→ [grid-docs / docs/install](https://github.com/gridplatform/grid-docs/tree/main/docs/install)

## Layout

| File | Purpose |
|------|---------|
| `install.sh` | Ubuntu VM installer (Node + systemd + nginx, or Compose) |
| `docker-compose.yml` | `core` + `ui` (UI image from public grid-ui) |
| `.env.example` | Auth, GitOps, **and remote state (`GRID_TF_*`)** |
| `systemd/grid-core.service` | API unit |
| `systemd/grid-ui.service` | Optional static UI via `serve` (nginx preferred) |
| `nginx-host.conf` | Host nginx: UI static + `/api` → core |
| `../Dockerfile` | Core image (bundles CLI + Terraform) |

**Before applying infra:** create remote state (S3 / GCS / Azure) and set `GRID_TF_*` —  
[remote-state.md](https://github.com/gridplatform/grid-docs/blob/main/docs/install/remote-state.md).

## Quick — Docker Compose

```bash
git clone https://github.com/gridplatform/grid-core.git
cd grid-core
cp install/.env.example install/.env
# edit GRID_AUTH_ADMIN_PASSWORD
docker compose -f install/docker-compose.yml --env-file install/.env up -d --build
```

Open `http://<host>/` (port `GRID_HTTP_PORT`, default 80).

## Quick — VM one-liner

```bash
export GRID_AUTH_ADMIN_PASSWORD='choose-a-strong-password'
curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```

Compose instead of systemd:

```bash
export GRID_USE_COMPOSE=1 GRID_AUTH_ADMIN_PASSWORD='…'
curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```
