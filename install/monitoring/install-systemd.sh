#!/usr/bin/env bash
# Install Prometheus + Alertmanager + Alloy as systemd units.
# Usage: sudo bash install/monitoring/install-systemd.sh


set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROM_VERSION="${PROM_VERSION:-2.55.1}"
AM_VERSION="${AM_VERSION:-0.27.0}"
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
mkdir -p /opt/prometheus /opt/alertmanager /opt/alloy \
  /etc/prometheus/rules /etc/alloy \
  /var/lib/prometheus /var/lib/alertmanager /var/lib/alloy /etc/grid
chown prometheus:prometheus /var/lib/prometheus /var/lib/alertmanager
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
install -m 0644 "$SCRIPT_DIR/rules/grid-alerts.yml" /etc/prometheus/rules/grid-alerts.yml
install -m 0644 "$SCRIPT_DIR/alertmanager.yml" /etc/prometheus/alertmanager.yml
chown -R prometheus:prometheus /etc/prometheus

echo "==> Alertmanager ${AM_VERSION} (${PROM_ARCH})"
AM_TGZ="alertmanager-${AM_VERSION}.linux-${PROM_ARCH}.tar.gz"
curl -fsSL -o "$TMP/$AM_TGZ" \
  "https://github.com/prometheus/alertmanager/releases/download/v${AM_VERSION}/${AM_TGZ}"
tar -xzf "$TMP/$AM_TGZ" -C "$TMP"
install -m 0755 "$TMP/alertmanager-${AM_VERSION}.linux-${PROM_ARCH}/alertmanager" /opt/alertmanager/alertmanager
install -m 0755 "$TMP/alertmanager-${AM_VERSION}.linux-${PROM_ARCH}/amtool" /opt/alertmanager/amtool

echo "==> Alloy ${ALLOY_VERSION} (${ALLOY_ARCH})"
ALLOY_ZIP="alloy-linux-${ALLOY_ARCH}.zip"
curl -fsSL -o "$TMP/$ALLOY_ZIP" \
  "https://github.com/grafana/alloy/releases/download/v${ALLOY_VERSION}/${ALLOY_ZIP}"
unzip -qo "$TMP/$ALLOY_ZIP" -d "$TMP/alloy"
ALLOY_BIN="$(find "$TMP/alloy" -type f -name 'alloy*' | head -1)"
install -m 0755 "$ALLOY_BIN" /opt/alloy/alloy
install -m 0644 "$SCRIPT_DIR/alloy-host.alloy" /etc/alloy/config.alloy
chown -R alloy:alloy /etc/alloy

if [[ ! -f /etc/grid/monitoring.env ]]; then
  install -m 0644 "$SCRIPT_DIR/monitoring.env.example" /etc/grid/monitoring.env
fi

echo "==> systemd units"
install -m 0644 "$SCRIPT_DIR/systemd/prometheus.service" /etc/systemd/system/prometheus.service
install -m 0644 "$SCRIPT_DIR/systemd/alertmanager.service" /etc/systemd/system/alertmanager.service
install -m 0644 "$SCRIPT_DIR/systemd/alloy.service" /etc/systemd/system/alloy.service
systemctl daemon-reload
systemctl enable --now prometheus.service
systemctl enable --now alertmanager.service
systemctl enable --now alloy.service

echo
echo "OK — prometheus + alertmanager + alloy"
echo "  systemctl status prometheus alertmanager alloy"
echo "  UI:            http://127.0.0.1:9090  ·  http://127.0.0.1:9093"
echo "  Local Grid:    GRID_PROMETHEUS_URL=http://127.0.0.1:9090"
echo "                 GRID_ALERTMANAGER_URL=http://127.0.0.1:9093"
echo "                 GRID_MONITORING_CONFIG_DIR=/etc/prometheus"
echo "  Compose Grid:  use host.docker.internal:9090 and :9093"
