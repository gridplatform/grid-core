# Grid Core

Runs Grid on your machine: the HTTP API behind the console, GitOps sync for desired-state JSON, releases with live logs, and the install packaging (Docker Compose / `install.sh`).

When you click plan or apply in the UI, core calls **[grid-cli](https://github.com/gridplatform/grid-cli)** to turn JSON into Terraform, then runs Terraform itself.

**Self-host:** [`install/`](./install/) · [grid-docs → Install](https://github.com/gridplatform/grid-docs/tree/main/docs/install)

## Quick start (Compose)

```bash
cp install/.env.example install/.env   # set GRID_AUTH_ADMIN_PASSWORD + GRID_TF_*
docker compose -f install/docker-compose.yml --env-file install/.env up -d --build
bash install/verify.sh
```

Ubuntu one-liner:

```bash
export GRID_AUTH_ADMIN_PASSWORD='choose-a-strong-password'
curl -fsSL https://raw.githubusercontent.com/gridplatform/grid-core/main/install/install.sh | sudo -E bash
```

Create **[remote Terraform state](https://github.com/gridplatform/grid-docs/blob/main/docs/install/remote-state.md)** before real applies. Prefer an instance role / service account on the host over long-lived cloud keys.

## Development

```bash
cp -n .env.example .env
npm install
npm run dev
```

API default: `http://localhost:3000`.

## Important environment

| Variable | Purpose |
|----------|---------|
| `GRID_GITOPS_REPO_URL` | **Your** desired-state GitHub repository (not a fork of the public example) |
| `GRID_CONFIG_ROOT` | Working tree for that JSON (GitOps checkout or local path) |
| `GRID_MODULE_BANK` | [grid-terraform](https://github.com/gridplatform/grid-terraform) — git URL or local path |
| `GRID_MODULE_BANK_REF` | Tag/branch when the bank is a git URL (prefer a release tag in production) |
| `GRID_CLI_ROOT` | Path to grid-cli |
| `GRID_TF_BACKEND` / `GRID_TF_STATE_*` | Remote state (required for production) |

[grid-config](https://github.com/gridplatform/grid-config) is a **sample** layout only. For real use, create your own repository and point `GRID_GITOPS_REPO_URL` at it.

Full env list: [grid-docs → Configuration](https://github.com/gridplatform/grid-docs/blob/main/docs/install/configuration.md) · [`install/.env.example`](./install/.env.example)

## Related repositories

| Repository | What it’s for |
|------------|---------------|
| [grid-ui](https://github.com/gridplatform/grid-ui) | Browser console |
| [grid-cli](https://github.com/gridplatform/grid-cli) | Command-line tool (also used by this API) |
| [grid-terraform](https://github.com/gridplatform/grid-terraform) | Terraform modules |
| [grid-docs](https://github.com/gridplatform/grid-docs) | Guides |

## License

MIT — see [LICENSE](LICENSE).
