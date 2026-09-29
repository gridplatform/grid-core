# Source

Grid Core HTTP API source.

## Layout

- `index.ts` / `app.ts` — process entry and Express app
- `config.ts` / `config/` — platform paths and provider helpers
- `routes/` — `/api/v1` and GitOps routes
- `services/` — lifecycle, GitOps sync, drift, deploy mapping, topology
- `store/` — in-memory store + GitOps settings/status files
- `types/` — API and GitOps contracts

See [../README.md](../README.md), [../docs/GITOPS.md](../docs/GITOPS.md), and
[../docs/LIFECYCLE.md](../docs/LIFECYCLE.md).
