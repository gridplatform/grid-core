# GitOps desired state

Grid does **not** treat `workspaces/` + `data/store.json` as the source of truth
for what *should* exist. Those are runtime caches.

**Source of truth:** a Git repository **you** create when you install Grid.
You commit Grid JSON there. Grid syncs it, plans/applies, and reports drift.

## Repo layout

```text
your-grid-desired-state/          # GRID_CONFIG_ROOT (owned by grid-core)
  infrastructures/                # or cloud/env/type layout
    demo-vpc/
      grid.json
```

Local demo (no remote Git, no grid-config):

`grid-core/examples/gitops-repo/` — default `GRID_CONFIG_ROOT`.

Each JSON is a normal Grid config (`provider`, `region`, `resources`, …).

## Delete / stale behavior

**Removing a JSON does not destroy cloud resources.**

On Sync:

1. Files present → create / update / unchanged.
2. Files that disappeared → infrastructure is marked **`stale`**.
3. Destroy only happens via an **explicit** destroy (CLI `grid prune --destroy` or API `POST …/destroy`) with operator confirmation.

Optional stable id:

```json
{
  "metadata": { "id": "11111111-1111-1111-1111-111111111111", "name": "demo-vpc", "environment": "development" },
  "provider": "aws",
  "region": "ap-south-1",
  "resources": []
}
```

If omitted, Grid derives a stable UUID from the file path.

## Operator flow

1. Use the local demo tree (`examples/gitops-repo`) or create a Git repo with the layout above.
2. In the console open **GitOps** → set repo URL / branch / path → **Save** → **Sync now** (skip for pure local demo JSON).
3. Synced stacks appear under GitOps and **Infrastructure**.
4. **Check drift** — Terraform plan of desired JSON vs state/live.
5. Choose:
   - **Match Git → live:** Plan → Apply (converge cloud to committed JSON).
   - **Keep live → update Git:** edit JSON, commit, Sync.
   - **JSON deleted:** Sync marks **stale** → confirm destroy via CLI/API.
6. Optional env on grid-core:

```bash
GRID_GITOPS_REPO_URL=https://github.com/you/grid-desired-state.git
GRID_GITOPS_BRANCH=main
GRID_GITOPS_PATH=infrastructures
GRID_GITOPS_SYNC_INTERVAL_SEC=60
```

## What “drift” means here

| Signal | Meaning |
|--------|---------|
| Git content hash ≠ last applied | Desired JSON changed since last successful Apply |
| `terraform plan` exit 2 | Live/state would change if you Apply current desired JSON |
| Plan empty (exit 0) | Live matches desired JSON |

Reverse-generating a full Grid JSON from Terraform state is **not** fully automated yet; drift reports include a **state inventory** plus guidance so you can update Git by hand.

## API

| Method | Path |
|--------|------|
| `GET` | `/api/v1/gitops/status` |
| `GET`/`PUT` | `/api/v1/gitops/settings` |
| `POST` | `/api/v1/gitops/sync` |
| `POST` | `/api/v1/infrastructures/:id/drift-check` |

See also [LIFECYCLE.md](./LIFECYCLE.md).
