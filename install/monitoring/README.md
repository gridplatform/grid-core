# Monitoring on the Grid VM — systemd only

Grid is a **client** for deploy/ops. Monitoring is an **underlying open-source
plane** on the VM. Same exit idea as Terraform remote state and generated
configs: remove Grid → you keep Prometheus/Alloy (and TF/state/K8s artifacts).
You only lose Grid’s console/API/workflows.

| Piece | How it runs | What it is |
|-------|-------------|------------|
| **Grid** (core + UI) | Docker Compose **or** `npm run prod` locally | Client / control plane |
| **Monitoring** (Prometheus + Alloy) | **systemd only** | Durable metrics plane |

**Never** install Prometheus/Alloy with Docker Compose. No monitoring containers.

**Intended:** tear down / remove **Grid** → **monitoring stays**.  
Not a normal step: tearing down monitoring while Grid is still the ops client.

## 1) Local production-style test (`npm run prod`)

### Linux (matches production VM)

```bash
sudo bash install/monitoring/install-systemd.sh   # Prometheus + Alloy once
# grid-core/.env
GRID_PROMETHEUS_URL=http://127.0.0.1:9090
cd grid-core && npm run prod
```

### macOS (no systemd — host binaries, same ports)

All commands below assume the **grid-core repository root** as the working
directory (`install/monitoring/...` is relative to that root).

```bash
# Terminal A — Prometheus
brew install prometheus
prometheus --config.file=install/monitoring/prometheus.yml \
  --storage.tsdb.path=/tmp/prometheus-data \
  --web.listen-address=127.0.0.1:9090 \
  --web.enable-remote-write-receiver

# Terminal B — Alloy (host metrics → local Prometheus)
brew install grafana/grafana/alloy
export GRID_PROM_REMOTE_WRITE_URL=http://127.0.0.1:9090/api/v1/write
alloy run install/monitoring/alloy-host.alloy \
  --storage.path=/tmp/alloy-data

# Terminal C — Grid (same host; set in .env first)
# GRID_PROMETHEUS_URL=http://127.0.0.1:9090
npm run prod
```

Prometheus + Alloy are on the host; Grid is on the host. Same loopback.
Stopping Grid does not stop them.

## 2) Production VM (customer deploy)

```bash
# A — monitoring (systemd)
sudo bash install/monitoring/install-systemd.sh

# B — Grid application (Compose) — separate lifecycle
cp install/.env.example install/.env
# GRID_PROMETHEUS_URL=http://host.docker.internal:9090
#   ↑ only means: Grid *container* talks to host Prometheus. Prometheus is not in Docker.
bash install/compose-up.sh
```

`host.docker.internal` is a **network path from the Grid container to the VM**.
It does **not** mean monitoring runs in Docker.

## Units

| Unit | Role |
|------|------|
| `prometheus.service` | Store + query + remote_write |
| `alloy.service` | Collector on this VM (optional host metrics) |

Managed infra: `POST /api/v1/monitoring/setup/:id` → Alloy configs; remote_write to this VM `:9090`.

See [docs/MONITORING.md](../../docs/MONITORING.md).
