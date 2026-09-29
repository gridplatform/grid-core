# Examples

## Desired-state for local testing

**Use `../demo-infra`** (sibling of `grid-core`). That is the default
`GRID_CONFIG_ROOT` owned by Core.

```text
../demo-infra/
  aws|gcp/
    development|staging|production/
      <infra-type>/              # vpc | ec2 | vm | s3 | gcs | …
        <name>.json              # intent
  archive/
    aws|gcp/…/<name>/            # Terraform buffer (grid generate)
```

Examples:

- `aws/development/vpc/dev-demo-vpc.json`
- `aws/development/ec2/dev-demo-app.json`
- `gcp/development/vpc/dev-demo-vpc.json`
- `gcp/development/vm/dev-demo-app.json`

Ephemeral copies of an env (TTL): `grid env clone development --name try-x --ttl 24h`

| Env | Default (from grid-core) |
|-----|--------------------------|
| `GRID_CONFIG_ROOT` | `../demo-infra` |
| `GRID_MODULE_BANK` | `../grid-terraform` |
| `GRID_CLI_ROOT` | `../grid-cli` |

## Legacy layout sketch

`examples/gitops-repo/` is a legacy sync-path sketch
(`infrastructures/<name>/grid.json`). Prefer the
`<cloud>/<env>/<type>/<name>.json` + `archive/` layout from `demo-infra`.
