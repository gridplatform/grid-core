# Install artifacts (self-host)

Scripts and Compose for running Grid on a VM or with Docker. Narrative guides:

→ [grid-docs / docs/install](https://github.com/gridplatform/grid-docs/tree/main/docs/install)

## Layout

| File | Purpose |
|------|---------|
| `install.sh` | **Default = Compose** on Ubuntu (detached + enable on boot); `GRID_USE_NATIVE=1` for systemd+nginx |
| `docker-compose.yml` | `core` + `ui` (`restart: unless-stopped`) |
| `verify.sh` | Smoke-check `/health` + UI |
| `.env.example` | Auth, GitOps, **remote state (`GRID_TF_*`)** |
| `systemd/grid-compose.service` | Bring Compose stack up on reboot |
| `systemd/grid-core.service` | Native API unit (`Restart=always`) |
| `systemd/grid-ui.service` | Optional (nginx preferred) |
| `nginx-host.conf` | Native: UI static + `/api` → core |
| `../Dockerfile` | Core image (bundles CLI + Terraform) |

**Before applying infra:** create remote state (S3 / GCS / Azure) and set `GRID_TF_*` —  
[remote-state.md](https://github.com/gridplatform/grid-docs/blob/main/docs/install/remote-state.md).

## Quick — Docker Compose (also the VM default)

```bash
git clone https://github.com/gridplatform/grid-core.git
cd grid-core
cp install/.env.example install/.env
# edit GRID_AUTH_ADMIN_PASSWORD (+ GRID_TF_* for real applies)
docker compose -f install/docker-compose.yml --env-file install/.env up -d --build
bash install/verify.sh
```

**Always use `-d` (detached).** Grid must not be tied to your SSH session.

For a server that should survive reboot:

```bash
sudo systemctl enable --now docker
sudo cp install/systemd/grid-compose.service /etc/systemd/system/
# if repo is not under /opt/grid/grid-core, edit WorkingDirectory in the unit
sudo systemctl daemon-reload
sudo systemctl enable --now grid-compose
```

Containers also have `restart: unless-stopped` so they come back after crashes.

## Quick — VM one-liner (Compose)

```bash
export GRID_AUTH_ADMIN_PASSWORD='choose-a-strong-password'
curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```

Native (no Docker):

```bash
export GRID_USE_NATIVE=1 GRID_AUTH_ADMIN_PASSWORD='…'
curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```
