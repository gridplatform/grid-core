# Kubernetes units in Grid

Grid keeps **three layers** as separate desired-state files so you can destroy
or change one piece without touching a thousand others.

| Layer | Console tab | Type (UI) | Example subtype | Path sketch |
|-------|-------------|-----------|-----------------|-------------|
| Cluster | **Infrastructure** | Kubernetes clusters | `eks`, `gke`, `aks` | `…/eks/my-cluster.json` |
| Node pool | **Infrastructure** | Kubernetes clusters | `eks-node-group`, `gke-node-pool` | `…/eks-node-group/workers-a.json` |
| Workload | **Workloads** | Workload / Helm / … | `k8s-deployment`, `helm-release` | future workload units |

## Rules

1. **One YAML (JSON) per cluster** — creates the control plane only.
2. **One YAML per node pool** — each pool is its own unit; destroy one pool without destroying the cluster or sibling pools.
3. **Workloads never live in the cluster JSON** — they use the Workloads tab / engine when those units exist.
4. Node pool files should name the cluster they attach to (`cluster_name` / `metadata.clusterRef`).

## Example (AWS)

```text
projects/demo-app/aws/development/
  eks/example-eks.json                 # cluster
  eks-node-group/example-workers.json  # pool A
  eks-node-group/example-gpu.json      # pool B (separate file)
```

## Example (GCP)

```text
projects/demo-app/gcp/development/
  gke/example-gke.json                 # cluster (node_pools left empty)
  gke-node-pool/example-workers.json   # one pool per file
```

The GKE Terraform module still accepts an embedded `node_pools` map for legacy
use; new config should leave it empty and use `gke-node-pool` units instead.
