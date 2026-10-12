#!/usr/bin/env bash
# Install Prometheus + Alloy as systemd units on this VM (no Docker Compose).
# Independent of Grid: systemctl stop grid-core / compose down does not stop these.
#
#   sudo bash install/monitoring/install-systemd.sh
#
# Upstream binaries only (prom/prometheus, grafana/alloy). Not Grid images.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROM_VERSION="${PROM_VERSION:-2.55.1}"
ALLOY_VERSION="${ALLOY_VERSION:-1.5.1}"

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) PROM_ARCH=amd64; ALLOY_ARCH=amd64 ;;
  aarch64|arm64) PROM_ARCH=arm64; ALLOY_ARCH=arm64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

if ! command -v curl >/dev/null || ! command -v unzip >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl unzip ca-certificates
  else
    echo "need curl and unzip on PATH" >&2
    exit 1
  fi
fi

echo "==> users/dirs"
id prometheus >/dev/null 2>&1 || useradd --system --home /var/lib/prometheus --shell /usr/sbin/nologin prometheus
id alloy >/dev/null 2>&1 || useradd --system --home /var/lib/alloy --shell /usr/sbin/nologin alloy
mkdir -p /opt/prometheus /opt/alloy /etc/prometheus /etc/alloy /var/lib/prometheus /var/lib/alloy /etc/grid
chown prometheus:prometheus /var/lib/prometheus
chown alloy:alloy /var/lib/alloy

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Prometheus ${PROM_VERSION} (${PROM_ARCH})"
PROM_TGZ="prometheus-${PROM_VERSION}.linux-${PROM_ARCH}.tar.gz"
curl -fsSL -o "$TMP/$PROM_TGZ" \
  "https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/${PROM_TGZ}"
tar -xzf "$TMP/$PROM_TGZ" -C "$TMP"
install -m 0755 "$TMP/prometheus-${PROM_VERSION}.linux-${PROM_ARCH}/prometheus" /opt/prometheus/prometheus
install -m 0755 "$TMP/prometheus-${PROM_VERSION}.linux-${PROM_ARCH}/promtool" /opt/prometheus/promtool
install -m 0644 "$SCRIPT_DIR/prometheus.yml" /etc/prometheus/prometheus.yml
chown -R prometheus:prometheus /etc/prometheus

echo "==> Alloy ${ALLOY_VERSION} (${ALLOY_ARCH})"
ALLOY_ZIP="alloy-linux-${ALLOY_ARCH}.zip"
curl -fsSL -o "$TMP/$ALLOY_ZIP" \
  "https://github.com/grafana/alloy/releases/download/v${ALLOY_VERSION}/${ALLOY_ZIP}"
unzip -qo "$TMP/$ALLOY_ZIP" -d "$TMP/alloy"
# zip layout: alloy-linux-amd64 binary
ALLOY_BIN="$(find "$TMP/alloy" -type f -name 'alloy*' | head -1)"
install -m 0755 "$ALLOY_BIN" /opt/alloy/alloy
install -m 0644 "$SCRIPT_DIR/alloy-host.alloy" /etc/alloy/config.alloy
chown -R alloy:alloy /etc/alloy

if [[ ! -f /etc/grid/monitoring.env ]]; then
  install -m 0644 "$SCRIPT_DIR/monitoring.env.example" /etc/grid/monitoring.env
fi

echo "==> systemd units"
install -m 0644 "$SCRIPT_DIR/systemd/prometheus.service" /etc/systemd/system/prometheus.service
install -m 0644 "$SCRIPT_DIR/systemd/alloy.service" /etc/systemd/system/alloy.service
systemctl daemon-reload
systemctl enable --now prometheus.service
systemctl enable --now alloy.service

echo
echo "OK — metrics stack (systemd, not Compose)"
echo "  systemctl status prometheus alloy"
echo "  Prometheus UI: http://127.0.0.1:9090"
echo "  Point Grid:    GRID_PROMETHEUS_URL=http://127.0.0.1:9090"
echo "  (If Grid runs in Docker Compose, use http://host.docker.internal:9090)"
