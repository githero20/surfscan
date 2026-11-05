# surfscan

Attack surface scanner for AI-assisted development.

surfscan is a local, read-only CLI that checks a project for the ways AI coding agents widen its attack surface: what agents read (instruction files, MCP configs), what they install (dependencies), what they can reach (keys and secrets), and what they can run without asking (auto-approved commands).

Every finding has a rule ID, severity, file and line, and a fix hint. It works on a developer machine, in a pre-commit hook and in CI.

## Install

Requires Node 20 or later.

Run it once, without installing:

```
npx surfscan scan .
```

Install it globally:

```
npm install -g surfscan
surfscan scan .
```

Add it to a project as a dev dependency:

```
npm install --save-dev surfscan
npx surfscan scan .
```

`npx surfscan` fetches the latest release each time it runs. To keep results repeatable, pin a version, for example `npx surfscan@0.1.0 scan .`, or install it as a dev dependency and commit the lock file.

To build from source:

```
git clone https://github.com/githero20/surfscan.git
cd surfscan
npm ci
npm run build
node dist/cli/bin.js scan .
```

### In CI or a pre-commit hook

```
npx surfscan@0.1.0 scan . --strict --fail-on high
```

Exit code 1 means a finding at or above `--fail-on`. Exit code 2 means an error, or with `--strict`, a check that could not run. See [Exit codes](#exit-codes).

When CI scans pull requests, add `--no-config`, or pass your own `--config <file>` from outside the repo. A pull request can change the `surfscan.json` in the scanned directory, and that file can turn checks off.

## Commands

Each command takes an optional path, which defaults to `.`.

| Command | What it does | Example |
| --- | --- | --- |
| `rules` | Checks agent instruction files for hidden or risky instructions | `surfscan rules .` |
| `mcp` | Audits MCP server configs and tool descriptions | `surfscan mcp --tools tools.json` |
| `deps` | Verifies dependencies against the npm registry | `surfscan deps --offline` |
| `keys` | Finds keys and secrets an agent can reach | `surfscan keys .` |
| `approvals` | Finds commands agents may run without asking | `surfscan approvals .` |
| `scan` | Runs all five and merges the results | `surfscan scan . --fail-on medium` |

Options for every command:

- `--format text|json`: output format (default `text`)
- `--fail-on high|medium|low|info`: exit 1 at or above this severity (default `high`)
- `--config <file>`: config file (default `surfscan.json` in the scanned directory, if present)
- `--no-config`: ignore any `surfscan.json` in the scanned directory
- `--no-color`: disable colored output
- `--strict`: exit 2 if any check could not run (see Exit codes)

Options for `deps` and `scan`:

- `--offline`: do not contact the registry; run local checks only

Options for `mcp`:

- `--tools <file.json>`: check an exported tool list
- `--connect`: launch each configured local server and list its tools
- `--yes`: skip the `--connect` questions; servers that are not pinned to a version are still skipped
- `--allow-unpinned`: with `--connect --yes`, launch unpinned servers too
- `--update-lock`: write tool description hashes to `.surfscan/mcp.lock.json`; needs `--tools` or `--connect`

### Checking MCP tool descriptions

Tool descriptions are not in config files; they come from the running server. MCP-001 and MCP-002 therefore need a tool list, and `surfscan mcp` and `surfscan scan` skip them without one.

A tool list can be a `tools/list` result (`{ "tools": [...] }`, optionally inside a JSON-RPC `result`), a bare array, or `{ "servers": { "<name>": { "tools": [...] } } }`.

`--connect` runs third-party code on your machine with your permissions. It never runs by default or under `scan`. What it does to limit the risk:

- It shows each server's command and the names of its `env` variables, then asks about that server alone. You can approve some and skip others. It refuses when nobody can answer, unless you pass `--yes`.
- A server that is not pinned to a version (for example `npx some-server`) runs whatever is newest, so it needs you to type the full word `yes`. With `--yes`, unpinned servers are skipped unless you also pass `--allow-unpinned`.
- Servers start with a minimal environment: `PATH`, home and temp folders, and proxy and certificate settings. Your other shell variables, such as tokens, are not passed on. The only way to give a server one is a `${VAR}` reference in its `env` block, and the prompt shows those names. `${VAR}` in a command or argument is passed as written, because anyone on the machine can read a command line. On Windows, a server with `%VAR%` in its command or arguments is not launched, because the shell would change what you approved.
- Remote specs (`github:`, `git+https:`, tarball URLs) count as unpinned unless they name a full commit hash, because what they point at can change.
- With `--update-lock`, servers that were skipped or failed to start keep their saved hashes.

This reduces what a server can reach; it is not a sandbox. A launched server can still read your files and use your network. To check servers you do not trust, run `--connect` in a container or throwaway machine, save the lock, and use `--tools` elsewhere.

## Rules

Details, examples and detection choices for each rule are in [docs/rules.md](docs/rules.md).

| ID | Severity | Finding |
| --- | --- | --- |
| RULES-001 | high | Invisible Unicode in instruction file |
| RULES-002 | high | Hidden instructions in comments or markup |
| RULES-003 | high | Download piped into a shell |
| RULES-004 | high | Instruction to read or send credentials |
| RULES-005 | high | Instruction to override earlier instructions or skip confirmation |
| RULES-006 | medium | Long encoded block |
| RULES-007 | medium | Instruction to install unpinned packages |
| RULES-008 | medium | Instruction to fetch and follow an external URL |
| MCP-001 | high | Injection-style text in tool description |
| MCP-002 | high | Tool description changed since the saved lock |
| MCP-003 | high | Server with filesystem access to the home directory or root |
| MCP-004 | medium | Server launched from an unpinned remote package |
| MCP-005 | medium | Server reached over plain http or an unknown host |
| MCP-006 | info | No lock file yet |
| DEPS-001 | high | Package does not exist on the registry |
| DEPS-002 | high | Name very close to a popular package |
| DEPS-003 | medium | Recent maintainer or owner change |
| DEPS-004 | medium | Newly published package |
| DEPS-005 | medium | Install scripts present |
| DEPS-006 | low | Unpinned version |
| DEPS-007 | low | Deprecated package |
| KEYS-001 | high | Live or production key |
| KEYS-002 | high | Env file with secrets not covered by .gitignore |
| KEYS-003 | medium | Wildcard or admin scope in cloud policy |
| APPR-001 | high | Bypass or auto-approve mode enabled |
| APPR-002 | high | Allowlist includes destructive commands |
| APPR-003 | high | Wildcard shell permission |
| APPR-004 | medium | All project MCP servers or tools auto-approved |
| APPR-005 | medium | File edits auto-approved |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Nothing at or above `--fail-on` |
| 1 | At least one finding at or above `--fail-on` |
| 2 | Usage or runtime error |

If the registry cannot be reached, `deps` prints a warning to stderr and reports only what it could check. By default the exit code does not change, so exit 0 means "nothing found among the checks that ran", not "verified". The text report ends with an `Incomplete:` line, and the JSON report has `"complete": false` and a `warnings` array.

In CI, pass `--strict`. If any check could not run, surfscan exits 2 instead of 0. Findings still take priority: exit 1 wins over exit 2. `--offline` is a choice, so it does not count as incomplete. These count as a check that could not run:

- The registry could not be reached.
- A config, manifest or lock file could not be parsed.
- A file was too large to read. The limit is 2 MiB, or 32 MiB for the files `deps` and `keys` read, since lock files and data files are often large. Exclude a generated file with `ignorePaths`.
- A link was not followed: a link to an agent folder such as `.claude`, or to a file outside the project. A link to a file inside the project is scanned.
- With `--connect`, a server failed, or `--yes` skipped it for not being pinned.
- A rule failed.

## Config

`surfscan.json`:

```json
{
  "ignore": ["RULES-006"],
  "ignorePaths": ["vendor/**"],
  "deps": { "minAgeDays": 30 }
}
```

- `ignore`: rule IDs to skip
- `ignorePaths`: globs to exclude from scanning
- `deps.minAgeDays`: DEPS-004 threshold in days (default 30)

Unknown keys are rejected with an error.

When a `surfscan.json` in the scanned directory turns checks off, surfscan says which ones in a warning, on stderr and in the JSON `warnings` array. A file you pass with `--config` is your own choice, so it gets no warning.

## What surfscan does not do

- It does not check keys against providers. "Live" refers to a key's format.
- It does not execute project or agent code. The one exception is `mcp --connect`, which is opt-in and asks first.
- It does not fix anything. The only file it writes is the MCP lock file, and only with `--update-lock`.
- It does not replace code review. Detection is static pattern matching, with the false positives and false negatives described in [docs/rules.md](docs/rules.md).

Only `deps`, and `scan` because it runs `deps`, uses the network. They contact npm's registry and download count endpoints and send package names only.
