# Changelog

All notable changes to **grid-core** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

**Platform operators:** see the docs [Changelog](https://gridplatform.github.io/doc/Install/Changelog)
and [Releases](https://gridplatform.github.io/doc/Install/Releases) for the combined control-plane story
(`install/releases.json` drives `install.sh` channels).

## [Unreleased]

### Added

- Production GitOps gate: HTTPS remotes require username + host token + expiry
- `install/releases.json`; `install.sh` pins via `GRID_REF`

## [0.1.0] — 2026-10-16

### Added

- API, GitOps sync, release runner, auth/RBAC
- Compose + VM `install.sh`; GHCR release workflow
- Remote Terraform state multi-backend support
- Monitoring API integration

[Unreleased]: https://github.com/gridplatform/grid-core/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gridplatform/grid-core/releases/tag/v0.1.0
