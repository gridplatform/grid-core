# Install

Compose, scripts, and systemd units for self-hosting Grid.

Guides: [grid-docs / docs/install](https://github.com/gridplatform/grid-docs/tree/main/docs/install)

## Layout

| File | Purpose |
|------|---------|
| `install.sh` | Ubuntu installer (Compose by default; `GRID_USE_NATIVE=1` for systemd + nginx) |
| `docker-compose.yml` | Build `core` and `ui` from source |
| `docker-compose.release.yml` | Run GHCR images (`lts` / `current` / exact version) |
| `verify.sh` | Smoke-check `/health` and the UI |
| `.env.example` | Auth, GitOps, release pins, remote state |
| `systemd/grid-compose.service` | Start Compose on boot |
| `systemd/grid-core.service` | Native API unit |
| `systemd/grid-ui.service` | Optional native UI unit |
| `nginx-host.conf` | Native reverse proxy |
| `../Dockerfile` | Core image (CLI + Terraform) |

Remote state before apply: [remote-state.md](https://github.com/gridplatform/grid-docs/blob/main/docs/install/remote-state.md).  
Channels and tags: [releases.md](https://github.com/gridplatform/grid-docs/blob/main/docs/install/releases.md).

## Docker Compose

```bash
git clone https://github.com/gridplatform/grid-core.git
cd grid-core
cp install/.env.example install/.env
```

Set `GRID_AUTH_ADMIN_PASSWORD`. Then:

```bash
docker compose -f install/docker-compose.yml --env-file install/.env up -d --build
bash install/verify.sh
```

Use detached mode (`-d`). For reboot persistence:

```bash
sudo systemctl enable --now docker
sudo cp install/systemd/grid-compose.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now grid-compose
```

Adjust `WorkingDirectory` in the unit if the repo is not under `/opt/grid/grid-core`.

## VM installer

```bash
export GRID_AUTH_ADMIN_PASSWORD='choose-a-strong-password'
curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```

Native (no Docker):

```bash
export GRID_USE_NATIVE=1 GRID_AUTH_ADMIN_PASSWORD='…'
curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```
