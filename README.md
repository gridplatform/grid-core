# Grid Core

HTTP API for Grid Console. Accepts deploy requests, maps them to CLI `grid.json`, runs `grid generate` + Terraform apply, and streams status/logs.

## Run

```bash
cd grid-core
cp -n .env.example .env   # if present
npm install
npm run dev
```

Listens on `http://localhost:3000` (`PORT`).

## Useful env

| Variable | Purpose |
|----------|---------|
| `GRID_CLI_ROOT` | Path to `grid-cli` (default: `../grid-cli`) |
| `GRID_WORK_DIR` | Terraform workspaces |
| `GRID_DATA_DIR` | JSON store |
| `GRID_TERRAFORM_BIN` | `terraform` binary |
| `GRID_AUTO_APPROVE` | Apply with `-auto-approve` (default true) |

## Deploy path

`POST /api/v1/deployments` with `{ name, engine, provider, environment, resourceType, config }`.

Terraform engine maps the request to `grid.json` (composers for vpc/subnet/vm;
passthrough for every other type) and runs `grid-cli generate` + Terraform apply
against the **grid-terraform** module bank. Follow with `GET /api/v1/deployments/:id`
and `.../logs`.

**Access model:** console feature flags only hide types in the UI and stop the UI
from sending them. The API and CLI do not read those flags — a correct request or
`grid.json` still runs if the module bank and credentials are ready.
