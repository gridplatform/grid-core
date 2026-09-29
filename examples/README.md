# Examples

Local desired-state for testing **without** `grid-config`.

## Demo GitOps tree

```text
examples/gitops-repo/                 ← GRID_CONFIG_ROOT (owned by grid-core)
  infrastructures/                    ← GRID_GITOPS_PATH
    demo-vpc/
      grid.json                       ← AWS VPC + subnet sample
```

grid-core defaults:

| Env | Default |
|-----|---------|
| `GRID_CONFIG_ROOT` | `./examples/gitops-repo` |
| `GRID_MODULE_BANK` | `../grid-terraform` |
| `GRID_CLI_ROOT` | `../grid-cli` |

When the API runs generate/plan/apply, it injects those into the CLI process.
The CLI does not invent product paths — Core does.

## CLI smoke (add-on)

From `grid-cli`, with Core’s defaults (or export the same env):

```bash
export GRID_CONFIG_ROOT=../grid-core/examples/gitops-repo
export GRID_MODULE_BANK=../grid-terraform

npm run grid -- generate \
  -c ../grid-core/examples/gitops-repo/infrastructures/demo-vpc/grid.json \
  --config-dir "$GRID_CONFIG_ROOT" \
  -o /tmp/grid-demo-vpc \
  --format terraform
```
