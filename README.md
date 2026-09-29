# Grid Core

HTTP API for Grid Console — **the heart of the platform**. Accepts deploy
requests, maps them to Grid JSON, runs the CLI add-on (`generate`) + Terraform,
and streams status/logs.

## Run

```bash
cd grid-core
cp -n .env.example .env
npm install
npm run dev
```

Listens on `http://localhost:3000` (`PORT`).

## Paths Core owns (injected into CLI)

| Variable | Purpose | Local default |
|----------|---------|----------------|
| `GRID_CONFIG_ROOT` | Desired-state root | `./examples/gitops-repo` |
| `GRID_MODULE_BANK` | `grid-terraform` module bank | `../grid-terraform` |
| `GRID_CLI_ROOT` | CLI package (add-on) | `../grid-cli` |
| `GRID_WORK_DIR` | Terraform workspaces | `./workspaces` |
| `GRID_DATA_DIR` | JSON store | `./data` |
| `GRID_TERRAFORM_BIN` | `terraform` binary | `terraform` |
| `GRID_AUTO_APPROVE` | Apply `-auto-approve` | `true` |

Demo unit: `examples/gitops-repo/infrastructures/demo-vpc/grid.json`.

## Deploy path

`POST /api/v1/deployments` with `{ name, engine, provider, environment, resourceType, config }`.

Terraform engine maps the request to Grid JSON and runs `grid-cli generate` +
Terraform apply against the **module bank from Core env**. Follow with
`GET /api/v1/deployments/:id` and `.../logs`.

**Access model:** console feature flags only hide types in the UI. The API and
CLI do not read those flags — a correct request or Grid JSON still runs if the
module bank and credentials are ready.
