# Install

Compose, scripts, and systemd units for self-hosting Grid.

Guides: [grid-docs / docs/install](https://gridplatform.org/doc/Install/Overview)

## Layout

| File | Purpose |
|------|---------|
| `install.sh` | Ubuntu installer — set `GRID_REF` to the tag you want (Compose by default; `GRID_USE_NATIVE=1` for systemd + nginx) |
| `releases.json` | Published releases index |
| `docker-compose.yml` | Build `core` and `ui` from source |
| `docker-compose.release.yml` | Run GHCR images (`current` / `lts` / exact version) |
| `verify.sh` | Smoke-check `/health` and the UI |
| `check-env.sh` | Hard-fail if `install/.env` is incomplete (no override) |
| `compose-up.sh` | Production entry: `check-env.sh` then Compose up |
| `.env.example` | Auth, GitOps, module bank `v0.1.0`, remote state (required) |
| `systemd/grid-compose.service` | Start Compose on boot |
| `systemd/grid-core.service` | Native API unit |
| `systemd/grid-ui.service` | Optional native UI unit |
| `nginx-host.conf` | Native reverse proxy |
| `monitoring/` | **systemd** Prometheus + Alloy (not Compose) — survives Grid stop/down |
| `../Dockerfile` | Core image (CLI + Terraform) |

Remote state before apply: [remote-state.md](https://gridplatform.org/doc/Install/Remote_State).  
Channels and tags: [releases.md](https://gridplatform.org/doc/Install/Releases).

## Docker Compose

```bash
git clone https://github.com/gridplatform/grid-core.git
cd grid-core
cp install/.env.example install/.env
```

Fill **all** required fields (auth, GitOps, `GRID_MODULE_BANK_REF=v0.1.0`, `GRID_TF_BACKEND` + bucket/lock). Compose is **production-only** — no dev profile:

```bash
bash install/compose-up.sh          # check-env + up -d --build
# bash install/compose-up.sh release
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
