#!/usr/bin/env bash
set -euo pipefail

mkdir -p sbom

write_gate_result() {
  cat > sbom/security-gate-result.json <<JSON
{
  "status": "$1",
  "scanner": "$2",
  "detail": "$3"
}
JSON
}

if npm audit --audit-level=high --json > sbom/npm-audit.json; then
  echo "npm audit completed successfully"
  write_gate_result "pass" "npm-audit" "npm audit completed"
  exit 0
fi

echo "npm audit failed or unavailable; attempting pinned OSV scanner" >&2
OSV_SCANNER_BIN="${OSV_SCANNER_BIN:-osv-scanner}"
EXPECTED_OSV_SCANNER_VERSION="${EXPECTED_OSV_SCANNER_VERSION:-1.9.2}"

if ! command -v "$OSV_SCANNER_BIN" >/dev/null 2>&1; then
  echo "Pinned osv-scanner is required in CI image but was not found: $OSV_SCANNER_BIN" >&2
  write_gate_result "fail" "missing-osv-scanner" "Install pinned osv-scanner in CI image"
  exit 1
fi

SCANNER_VERSION="$($OSV_SCANNER_BIN --version 2>/dev/null | awk 'NR==1{print $NF}')"
if [[ "$SCANNER_VERSION" != "$EXPECTED_OSV_SCANNER_VERSION" ]]; then
  echo "Unexpected osv-scanner version: got '$SCANNER_VERSION', expected '$EXPECTED_OSV_SCANNER_VERSION'" >&2
  write_gate_result "fail" "osv-scanner-version-mismatch" "Pin osv-scanner version in CI image"
  exit 1
fi

if "$OSV_SCANNER_BIN" --lockfile=package-lock.json --format=json --output=sbom/osv-audit.json; then
  echo "OSV scan completed; review sbom/osv-audit.json" >&2
  write_gate_result "pass" "osv-scanner" "osv-scanner completed"
  exit 0
fi

echo "OSV scan failed" >&2
write_gate_result "fail" "osv-scanner" "osv-scanner execution failed"
exit 1
