# Monitoring (host)

Prometheus (metrics + rules), Alertmanager (notify), optional Alloy (collector).  
Runs on the **host** (systemd or local binaries) — not in Grid Compose.

| Component | Port | Operate |
|-----------|------|---------|
| Prometheus | `:9090` | Store/query metrics; evaluate alert rules |
| Alertmanager | `:9093` | Route/notify firings |
| Alloy | — | Scrapes → `remote_write` to Prometheus |

**Alerts UI:** list firings from Alertmanager. **Settings:** write `rules/` + `alertmanager.yml` under `GRID_MONITORING_CONFIG_DIR`, then `POST /-/reload`.

## Local (`npm run prod`)

From **grid-core** root. Set in `.env`:

```bash
GRID_PROMETHEUS_URL=http://127.0.0.1:9090
GRID_ALERTMANAGER_URL=http://127.0.0.1:9093
GRID_MONITORING_CONFIG_DIR=./install/monitoring
```

```bash
# Prometheus — --web.enable-lifecycle required for Settings reload
prometheus --config.file=install/monitoring/prometheus.yml \
  --storage.tsdb.path=/tmp/prometheus-data \
  --web.listen-address=127.0.0.1:9090 \
  --web.enable-remote-write-receiver \
  --web.enable-lifecycle

# Alertmanager
alertmanager --config.file=install/monitoring/alertmanager.yml \
  --storage.path=/tmp/alertmanager-data \
  --web.listen-address=127.0.0.1:9093

# Optional Alloy
export GRID_PROM_REMOTE_WRITE_URL=http://127.0.0.1:9090/api/v1/write
alloy run install/monitoring/alloy-host.alloy --storage.path=/tmp/alloy-data

npm run prod
```

Linux VM-style local install: `sudo bash install/monitoring/install-systemd.sh` then the same `.env` URLs.

## Production VM

```bash
sudo bash install/monitoring/install-systemd.sh
systemctl status prometheus alertmanager alloy

# install/.env (Grid Compose → host)
GRID_PROMETHEUS_URL=http://host.docker.internal:9090
GRID_ALERTMANAGER_URL=http://host.docker.internal:9093
GRID_MONITORING_CONFIG_DIR=/etc/prometheus
GRID_MONITORING_HOST_DIR=/etc/prometheus

bash install/compose-up.sh
```

## Collectors on managed infra

`POST /api/v1/monitoring/setup/:id` writes Alloy config; remote_write to this host `:9090`.

See [docs/MONITORING.md](../../docs/MONITORING.md).
