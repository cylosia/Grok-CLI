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

echo "npm audit failed or unavailable; attempting OSV lockfile scan" >&2
if command -v osv-scanner >/dev/null 2>&1 && \
  osv-scanner --lockfile=package-lock.json --format=json --output=sbom/osv-audit.json; then
  echo "OSV scan completed; review sbom/osv-audit.json" >&2
  write_gate_result "pass" "osv-scanner" "osv-scanner completed"
  exit 0
fi

echo "OSV scan unavailable (install pinned osv-scanner in CI image); generating fallback SBOM only" >&2
npm ls --all --json > sbom/npm-sbom.json
write_gate_result "fail" "fallback-sbom" "No vulnerability scanner available; install pinned osv-scanner in CI image"
exit 1
