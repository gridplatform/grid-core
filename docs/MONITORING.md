# Monitoring

Fleet health for every infrastructure unit. Grid joins inventory to a metrics
backend when configured; otherwise it uses control-plane status.

## Exit model (read this first)

Grid is a **client** on top of open tooling: deploy orchestration, desired-state,
approvals, UI. It is not the system of record for the things it manages.

If you remove Grid from the VM, you keep the underlying components — for example:

- Terraform / OpenTofu and **remote state**
- Generated configs / archive exit buffers
- Kubernetes / GitOps manifests (when that path is in use)
- **Monitoring** (Prometheus + Alloy as systemd on the host)

You lose what Grid uniquely provided (console, API, Grid-specific workflows).
You do **not** lose the infra, state, or metrics stack just because Grid is gone.

On a production VM that means **two installs**, decoupled so Grid can leave first:

1. **Grid application** — core + UI via Docker Compose (or `npm run prod` for a
   production-style laptop test). Safe to stop / remove without touching metrics.
2. **Monitoring** — Prometheus + Alloy via **systemd only**. Never Compose.
   Never a monitoring Docker image from Grid.

**Intended:** remove Grid → monitoring (and TF/state/K8s artifacts) stay.  
**Not an ops goal:** tearing down monitoring as a normal step while Grid is in use.

```bash
sudo bash install/monitoring/install-systemd.sh   # prometheus + alloy units
systemctl status prometheus alloy

# Grid is separate:
bash install/compose-up.sh          # production VM
# or: npm run prod                  # laptop production-style test
```

## Where Prometheus is hosted

**On the VM (or laptop) OS**, as `prometheus.service`.  
Not inside Grid’s Compose file. Not a Grid container.

| How you run Grid | `GRID_PROMETHEUS_URL` | Meaning |
|------------------|------------------------|---------|
| `npm run prod` on host | `http://127.0.0.1:9090` | Grid process → local Prometheus |
| Compose on the VM | `http://host.docker.internal:9090` | Grid **container** → **host** Prometheus |

`host.docker.internal` is only container→host networking. Monitoring stays systemd.

## Behavior

| `GRID_PROMETHEUS_URL` | Health source |
|-----------------------|---------------|
| Unset | Inventory status |
| Set + `up{grid_unit_id=…}` present | Metrics (`up`) |
| Set + no series, profile `host` / `kubernetes` | **unknown** (collector expected) |
| Set + no series, profile `labels-only` | **Inventory** (managed / network / storage / … until a metrics bridge stamps `grid_unit_id`) |
| Query fails | Inventory fallback |

Profiles are structural (workload agent vs labels-only), not a cloud or product catalog.

APIs: dashboards, health, metrics, alerts, collector-config, setup.

## Collectors on managed infrastructure

`POST /api/v1/monitoring/setup/:infra` writes Alloy config under desired-state.
Run Alloy on those hosts with remote_write to the Grid VM’s `:9090`.

Join label: **`grid_unit_id`** = infrastructure unit id (UUID v5 of desired-state
path by default, or optional `metadata.id`). Path-based TF state is unrelated.

Profiles: `host`, `kubernetes`, `labels-only`.

See [`install/monitoring/README.md`](../install/monitoring/README.md) and
[`GITOPS.md`](./GITOPS.md) (unit id).
