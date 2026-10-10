# Kubernetes in Grid

Grid keeps **three layers** as separate desired-state files so you can destroy
or change one piece without touching a thousand others.

| Layer | Console | Engine | Example | Path sketch |
|-------|---------|--------|---------|-------------|
| Cluster | Infrastructure | Terraform | `eks`, `gke`, `aks` | `…/eks/my-cluster.json` |
| Node pool | Infrastructure | Terraform | `eks-node-group`, `gke-node-pool` | `…/eks-node-group/workers-a.json` |
| Workload | Workloads / Releases | **Argo CD** (OpenShift GitOps OK) | `workload`, `helm-release` | `…/workloads/…` or API deploy |

## Rules

1. **One JSON per cluster** — control plane only (Terraform).
2. **One JSON per node pool** — destroy one pool without the cluster or siblings.
3. **Workloads never live in the cluster JSON** — they are Argo `Application` CRs.
4. Node pool files name the cluster (`cluster_name` / `metadata.clusterRef`).
5. **GitOps everywhere** — same Argo Application CRD for upstream Argo CD and
   OpenShift GitOps. Grid does not `kubectl apply` app manifests; Argo reconciles.

## Workloads (Argo)

Enable on Core:

```bash
GRID_ARGO_ENABLED=1
GRID_ARGO_KUBECONFIG=/path/to/kubeconfig   # or export KUBECONFIG=
# GRID_ARGO_CONTEXT=my-context             # optional
GRID_ARGO_NAMESPACE=argocd                 # or openshift-gitops
# GRID_KUBECTL_BIN=kubectl
```

### Intent JSON → Application CR

Workload units use `engine: "kubernetes"`. Core maps them to
`argoproj.io/v1alpha1/Application` and writes YAML under:

```text
$GRID_CONFIG_ROOT/argo/<unit>/application.yaml
```

Lifecycle (same modes as Terraform):

| Mode | Behavior |
|------|----------|
| **plan** | Apply Application CR (no forced sync) + report sync/health |
| **apply** | Apply Application CR + trigger sync (prune) |
| **destroy** | Delete Application CR; catalog row stays **pending** when intent JSON remains |

Approval gates stay in Grid Releases — default is no Argo auto-sync (`autoSync: false`).

### Minimal intent

```json
{
  "engine": "kubernetes",
  "kind": "helm-release",
  "metadata": {
    "name": "demo-api",
    "environment": "development",
    "clusterRef": "example-eks"
  },
  "destination": { "namespace": "demo" },
  "cluster": { "name": "in-cluster" },
  "source": {
    "repoURL": "https://github.com/example/gitops.git",
    "path": "apps/demo-api",
    "targetRevision": "main"
  },
  "autoSync": false
}
```

### Deploy API

`POST /api/v1/deployments` with `engine: "kubernetes"` maps `config` into the
intent above and runs the Argo lifecycle (requires `GRID_ARGO_ENABLED=1`).

Releases with a kubernetes infrastructure unit set `type: "kubernetes"` and use
the same path.

## Example (AWS cluster + pools)

```text
projects/demo-app/aws/development/
  eks/example-eks.json
  eks-node-group/example-workers.json
  eks-node-group/example-gpu.json
```

## Example (GCP)

```text
projects/demo-app/gcp/development/
  gke/example-gke.json
  gke-node-pool/example-workers.json
```

The GKE Terraform module still accepts an embedded `node_pools` map for legacy
use; new config should leave it empty and use `gke-node-pool` units instead.
