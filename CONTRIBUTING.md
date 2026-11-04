# Contributing

## Set up

Node 20 or later.

```
npm ci
npm test
npm run typecheck
npm run build
```

## Rules

- **Rule IDs are permanent.** Once released, an ID is never renumbered or reused. To retire a rule, keep its entry in `docs/rules.md` and mark it removed.
- **Each rule needs:** an entry in `docs/rules.md` (risk, bad example, fix), a row in the README table, and a folder `tests/fixtures/<RULE-ID>/` with a `bad` and a `clean` sample. A test checks all three.
- **Test names start with the rule ID**, for example `RULES-001 flags zero-width characters`.
- **No test may touch the network.** Inject a fake `fetch`.
- **Fixtures never hold real-looking secrets.** Use the `__FAKE_*__` placeholders described in `tests/fixtures/README.md`.

## Design limits

- `core/` and `scanners/` must not use `process`, `child_process` or `commander`. Only `cli/` may. A test enforces this.
- Static checks only. surfscan does not call provider APIs to test keys, run project code, or edit user files. The one file it writes is the MCP lock file, and only when asked.
- Never print a full secret. Mask to the first four characters, then `...`.
- Keep runtime dependencies small. Prefer Node built-ins.

## Pull requests

Run `npm test` and `npm run typecheck` first. Describe what changed and why, and mention any rule whose severity or detection changed.
