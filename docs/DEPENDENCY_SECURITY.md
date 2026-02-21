# Dependency security policy

## Release gates
- Run `npm ci --ignore-scripts` in CI before any build artifact is produced.
- Run `npm run -s audit:ci` against an authenticated npm registry mirror.
- Fail release pipelines on unresolved high/critical advisories.

## SBOM fallback and attestation
When registry audit endpoints are unavailable, generate and archive an SBOM artifact:

```bash
npm run -s sbom:generate
```

This writes `sbom/npm-sbom.json`, which must be attached to release artifacts for downstream CVE scanning.

## Operational notes
- Prefer fixed lockfile updates (`npm ci`) over floating installs in CI.
- Investigate and document every production exception to these controls.
