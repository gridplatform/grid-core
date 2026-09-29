# GitOps desired state

Grid does **not** treat `workspaces/` + `data/store.json` as the source of truth
for what *should* exist. Those are runtime caches.

**Source of truth:** `GRID_CONFIG_ROOT` — one working tree for **local testing** and
**remote GitHub** alike. Intent JSON and `archive/` instance Terraform always
live here. Behavior does not fork by transport.

## Repo layout (same local or remote)

```text
GRID_CONFIG_ROOT/                 # demo-infra locally, or clone of your GitHub repo
  <cloud>/                         # aws | gcp | …
    development|staging|production/
      <infra-type>/                # vpc | ec2 | vm | eks | gke | …
        <name>.json                # intent (edit / commit this)
  archive/                         # instance Terraform (CLI/Core regenerate)
    <cloud>/<env>/<type>/<name>/
      main.tf …                    # rewritten from JSON on generate/plan/deploy
      modules/                     # vendored from GRID_MODULE_BANK (bank never modified)
```

| Mode | `GRID_CONFIG_ROOT` | GitOps |
|------|--------------------|--------|
| Local demo | `../demo-infra` | optional / off — files on disk |
| Customer local | folder from `grid init` | optional |
| Remote GitHub | checkout of that repo (same path Core syncs) | Sync pulls into this root |

JSON change → regenerate **`archive/` instance HCL** (not the module bank). Same
whether you run `grid generate` locally or Core plan/apply after Sync.

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

1. Point Core at the desired-state tree: `export GRID_CONFIG_ROOT=/path/to/repo`
   (local demo: `../demo-infra`).
2. Optional remote: set GitOps repo URL / branch (path prefix empty = repo root
   with `aws|gcp/…` layout) → **Sync now**.
3. Plan / Apply / CLI `generate` all write `archive/` under that same root.
4. Commit + push `archive/` with your JSON if you want the exit buffer in GitHub.
5. Optional env:

```bash
GRID_CONFIG_ROOT=/path/to/desired-state
GRID_MODULE_BANK=/path/to/grid-terraform
GRID_GITOPS_REPO_URL=https://github.com/you/grid-desired-state.git
GRID_GITOPS_BRANCH=main
GRID_GITOPS_PATH=           # empty = cloud/env/type at repo root
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
