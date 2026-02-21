#!/usr/bin/env bash
set -euo pipefail

mkdir -p sbom

if npm audit --audit-level=high --json > sbom/npm-audit.json; then
  echo "npm audit completed successfully"
  exit 0
fi

echo "npm audit failed or unavailable; attempting OSV lockfile scan" >&2
if command -v osv-scanner >/dev/null 2>&1 && \
  osv-scanner --lockfile=package-lock.json --format=json --output=sbom/osv-audit.json; then
  echo "OSV scan completed; review sbom/osv-audit.json" >&2
  exit 0
fi

echo "OSV scan unavailable (install pinned osv-scanner in CI image); generating fallback SBOM only" >&2
npm ls --all --json > sbom/npm-sbom.json
exit 1
