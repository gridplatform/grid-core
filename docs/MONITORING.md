# Monitoring

Unit health (metrics when available, else inventory) and configured alerts.

## Operate

| Piece | Where | Command / env |
|-------|--------|----------------|
| Prometheus + Alertmanager (+ Alloy) | Host OS | `install/monitoring/install-systemd.sh` **or** local binaries |
| Grid core + UI | Compose **or** `npm run prod` | Talks to host via URLs below |

| Scenario | Prometheus / Alertmanager | Config dir |
|----------|---------------------------|------------|
| Local `npm run prod` | `http://127.0.0.1:9090` / `:9093` | `./install/monitoring` |
| VM Compose | `http://host.docker.internal:9090` / `:9093` | `/etc/prometheus` (bind-mount) |

`npm run prod` / Compose boot checks those URLs (`/-/ready`, `/-/reload`) and that the config dir is writable. `npm run dev` skips that.

Details: [`install/monitoring/README.md`](../install/monitoring/README.md).

## Health

| Condition | Source |
|-----------|--------|
| `up{grid_unit_id=…}` present | Prometheus |
| Host/K8s profile, no series yet | `unknown` |
| Labels-only / no Prom | Inventory status |
| Prom query fails | Inventory fallback |

## Alerts

| UI | Does |
|----|------|
| **Alerts** | Lists firings (`firing` / `suppressed` / `resolved`) from Alertmanager |
| **Settings** | CRUD rules → `rules/grid-alerts.yml`; channels → `alertmanager.yml`; then reload |

APIs: dashboards, health, metrics, alerts, alert-rules, alert-channels, collector-config, setup.

## Collectors

`POST /api/v1/monitoring/setup/:infra` → Alloy under desired-state; remote_write to host `:9090`.  
Join label: `grid_unit_id`. Profiles: `host`, `kubernetes`, `labels-only`.

See [`GITOPS.md`](./GITOPS.md) for unit id.
