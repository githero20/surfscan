# Changelog

## 0.1.0 (unreleased)

First release.

- Five scanners: `rules`, `mcp`, `deps`, `keys`, `approvals`, plus `scan` to run them all.
- 29 rules: RULES-001 to 008, MCP-001 to 006, DEPS-001 to 007, KEYS-001 to 003, APPR-001 to 005.
- Text and JSON reports. JSON includes `complete` and `warnings`, so an empty result from an incomplete scan is not mistaken for a clean one.
- `--fail-on` threshold and `--strict`, which exits 2 when a check could not run.
- `deps --offline` for local-only checks.
- `mcp --tools` to check an exported tool list, `--update-lock` to save description hashes, and opt-in `--connect` to list tools from local servers (per-server confirmation, minimal environment, unpinned servers need explicit approval).
- `surfscan.json` config with `ignore`, `ignorePaths` and `deps.minAgeDays`. A config in the scanned project that turns checks off is reported, and `--no-config` ignores it.
