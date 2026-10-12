# Alloy collectors (Grid Monitoring)

Grafana Alloy ships metrics to a Prometheus-compatible remote_write endpoint.
Grid joins those series to inventory via **`grid_unit_id`**.

Prefer generating unit-specific config from the API:

```http
GET  /api/v1/monitoring/collector-config/:infrastructureId
POST /api/v1/monitoring/setup/:infrastructureId
```

`POST` writes `$GRID_CONFIG_ROOT/monitoring/.../collector.alloy` (desired-state /
GitOps buffer). It does **not** install Alloy on the workload.

## Profiles

| Profile | Use when | What it scrapes |
|---------|----------|-----------------|
| `host` | VM / instance units | `prometheus.exporter.unix` (node metrics) |
| `kubernetes` | Cluster / node-pool units | Kubernetes node + pod discovery |
| `labels-only` | Other managed types | Identity stamp only — attach your exporters |

All profiles are **provider-agnostic** (including APAC clouds). Depth of coverage
comes from running the collector where the resource lives, not from Grid
special-casing a vendor.

## Env on the collector host/cluster

```bash
GRID_PROM_REMOTE_WRITE_URL=http://prometheus.example:9090/api/v1/write
```

On grid-core, point query at the same Prometheus:

```bash
GRID_PROMETHEUS_URL=http://prometheus.example:9090
```

See [docs/MONITORING.md](../../docs/MONITORING.md).
