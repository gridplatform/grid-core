# Grid Core authentication

Grid Console uses a **Jenkins-style internal user database**: accounts and password hashes live on disk next to other Core state (`GRID_DATA_DIR/users.json`). Sessions are opaque API tokens (Bearer or `X-Grid-Token`) suitable for local dev, a VM install, or Kubernetes (mount a persistent volume on `GRID_DATA_DIR`).

## Quick start (local)

1. Set bootstrap admin in `grid-core/.env`:

```env
GRID_AUTH_ADMIN_EMAIL=you@example.com
GRID_AUTH_ADMIN_PASSWORD=change-me-now
```

2. Start Core and UI. Log in on the Console with that email and password.

On first boot, if no users exist, Core creates one admin from those variables (or `admin@grid.local` with a random password printed to the log).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRID_AUTH_DISABLED` | `false` | Skip auth; all API routes open; audit fields use demo user. **Dev only.** |
| `GRID_AUTH_ADMIN_EMAIL` | — | Bootstrap admin email when the user DB is empty |
| `GRID_AUTH_ADMIN_PASSWORD` | — | Bootstrap admin password |
| `GRID_AUTH_ADMIN_NAME` | `Grid Admin` | Display name for bootstrap admin |
| `GRID_AUTH_SESSION_TTL_HOURS` | `168` (7 days) | Session lifetime |
| `GRID_AUTH_ALLOW_REGISTER` | `false` | Allow `POST /api/v1/auth/register` (developer role) |

## API

- `POST /api/v1/auth/login` — `{ email, password }` → `{ token, user, expiresAt }`
- `GET /api/v1/auth/me` — current user (requires token)
- `POST /api/v1/auth/logout` — invalidate session
- `POST /api/v1/auth/register` — only if `GRID_AUTH_ALLOW_REGISTER=true`
- `GET/POST/PATCH /api/v1/auth/users` — **admin** user management

Send the token on every request:

```http
Authorization: Bearer <token>
```

or

```http
X-Grid-Token: <token>
```

## Roles

- **developer** — read and routine operations
- **maintainer** — elevated ops (future fine-grained policy)
- **admin** — user management and Console admin features

## Deployment notes

- **VM / single host:** persist `GRID_DATA_DIR` (contains `users.json` and `store.json`).
- **Kubernetes:** mount a PVC at `/data` (or your chosen `GRID_DATA_DIR`); set bootstrap admin via Secret → env.
- **Future:** OIDC/SSO can sit in front of or replace local login without changing UI token flow.
