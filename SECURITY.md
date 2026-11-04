# Security policy

surfscan reads project files and, for `deps`, contacts the npm registry. `mcp --connect` also launches the MCP servers you approve. A flaw in any of these can matter, so please report problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Include what you found, the surfscan version, and the smallest project or input that shows it. You will get a reply within a week.

## What counts

- Output that prints a full secret instead of a masked one.
- A scanned file that can run code, rewrite the terminal output, or make surfscan write outside `.surfscan/`.
- `mcp --connect` launching a server without the confirmation it promises, or passing it environment variables it should not.
- `deps` sending anything other than package names to the registry.

False positives and missed detections are not security flaws. Report them as ordinary issues, with a sample.

## Supported versions

Only the latest release gets fixes.
