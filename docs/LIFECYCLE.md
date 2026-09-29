# Infrastructure desired-state lifecycle (smoke)

One infrastructure id owns one desired-state JSON. Terraform runs from:

- **GitOps / gitPath units:** `GRID_CONFIG_ROOT/archive/<cloud>/<env>/<type>/<name>/`
- **API-only units (no gitPath):** `grid-core/workspaces/<id>/generated/`

## Flow

```text
create (JSON) → plan → apply → edit JSON → plan → apply → destroy
```

Terraform decides create / change / destroy from JSON vs state. Grid exposes that.

## API

| Step | Call |
|------|------|
| Create record only | `POST /api/v1/infrastructures` |
| Create + plan | `POST /api/v1/infrastructures?plan=true` |
| Create + apply | `POST /api/v1/infrastructures?apply=true` |
| Update desired state | `PATCH /api/v1/infrastructures/:id` `{ "configJson": { ... } }` |
| Plan | `POST /api/v1/infrastructures/:id/plan` |
| Apply | `POST /api/v1/infrastructures/:id/apply` |
| Destroy | `POST /api/v1/infrastructures/:id/destroy` or `DELETE /api/v1/infrastructures/:id` |
| Console create | `POST /api/v1/deployments` with `mode: "plan" \| "apply"` |

## CLI

```bash
cd grid-cli
grid generate -c examples/simple-vpc-vm-aws.json -o ./generated --format terraform
grid plan    -c examples/simple-vpc-vm-aws.json -o ./generated --format terraform
grid deploy  -c examples/simple-vpc-vm-aws.json -o ./generated --format terraform --auto-approve
# edit the JSON, then plan/deploy again to converge
grid destroy -c examples/simple-vpc-vm-aws.json -o ./generated --format terraform --auto-approve
```

## Live logs

While a plan/apply/destroy runs, grid-core streams CLI + Terraform stdout/stderr into the
deployment log buffer. The console opens an SSE stream:

`GET /api/v1/deployments/:id/logs/stream`

(Deployments and Infrastructure detail show a **Live CLI / Terraform output** panel.)

## Console

1. Start core: `cd grid-core && npm run dev`
2. UI `.env`: `VITE_USE_MOCK_DATA=false`, `VITE_GRID_API_URL=http://localhost:3000/api/v1`
3. **Deployments** → New → **Plan** or **Apply** (creates infra + runs lifecycle)
4. **Infrastructure** list shows live records → open one for Edit / Plan / Apply / Destroy
5. Optional: import existing Terraform by placing state under `workspaces/<id>/generated/` and registering the infra via API/CLI (manual)

Deploy logic is in `src/services/lifecycleService.ts` (re-exported from `deployService.ts`).

## Notes

- Requires cloud credentials for apply/destroy (e.g. AWS).
- Kubernetes engine still returns 501 from `POST /deployments`.
- Workspaces and `data/store.json` persist locally under grid-core.
