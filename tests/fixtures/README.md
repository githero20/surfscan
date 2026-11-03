# Fixtures

One folder per rule, each with a `bad` sample that must trigger the rule and a `clean` sample that must not.

Two conventions keep the fixtures safe to commit:

- **Token placeholders.** Files never contain real-looking secrets. Placeholders such as `__FAKE_GITHUB_TOKEN__` are replaced with generated values when a test runs (see `materialize` in `tests/helpers.ts`). This keeps secret scanners and push protection quiet.
- **`dot.` prefix.** A file or folder named `dot.env` or `dot.gitignore` becomes `.env` or `.gitignore` in the test copy. Otherwise this repo's own git (and a developer's global ignore file) would treat the fixture `.gitignore` and `.env` files as real ones.

Fixtures that use either convention are read through `materialize`, which copies them to a temporary directory first.
