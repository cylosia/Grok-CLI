#!/usr/bin/env bash
set -euo pipefail

mkdir -p sbom

write_gate_result() {
  local status="${1//\"/\\\"}"
  local scanner="${2//\"/\\\"}"
  local detail="${3//\"/\\\"}"
  printf '{\n  "status": "%s",\n  "scanner": "%s",\n  "detail": "%s"\n}\n' \
    "$status" "$scanner" "$detail" > sbom/security-gate-result.json
}

# Try npm audit first; capture exit code separately so set -e does not abort.
npm_audit_rc=0
npm audit --audit-level=high --json > sbom/npm-audit.json 2>/dev/null || npm_audit_rc=$?

# npm audit exit codes: 0 = no vulns at requested level, non-zero = vulns found
# or tool genuinely unavailable.  Check whether it produced valid JSON to tell
# the two cases apart.
if [[ -s sbom/npm-audit.json ]] && node -e "JSON.parse(require('fs').readFileSync('sbom/npm-audit.json','utf8'))" 2>/dev/null; then
  if [[ $npm_audit_rc -eq 0 ]]; then
    echo "npm audit completed successfully — no high-severity vulnerabilities"
    write_gate_result "pass" "npm-audit" "npm audit clean"
  else
    echo "npm audit completed — vulnerabilities found; see sbom/npm-audit.json" >&2
    write_gate_result "fail" "npm-audit" "npm audit found high-severity vulnerabilities"
    exit 1
  fi
  exit 0
fi

# npm audit genuinely unavailable — fall back to osv-scanner.
echo "npm audit unavailable; attempting pinned OSV scanner" >&2
OSV_SCANNER_BIN="${OSV_SCANNER_BIN:-osv-scanner}"
EXPECTED_OSV_SCANNER_VERSION="${EXPECTED_OSV_SCANNER_VERSION:-1.9.2}"

if ! command -v "$OSV_SCANNER_BIN" >/dev/null 2>&1; then
  echo "osv-scanner not found: $OSV_SCANNER_BIN" >&2
  write_gate_result "fail" "missing-scanner" "Neither npm audit nor osv-scanner available"
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
