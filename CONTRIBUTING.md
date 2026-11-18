# Contributing

Thanks for helping make the switch predictable. Focused fixes, reproductions, and clear behavior reports are welcome.

## Before opening an issue

- Search existing issues and the [changelog](CHANGELOG.md).
- State your OpenCode version, operating system, and plugin options.
- Describe which account was current, which limit you expected, and what the `go_accounts` tool reported.
- Remove keys, key fragments, account identifiers you do not want public, and personal paths from logs and examples.
- Use [private vulnerability reporting](https://github.com/xonika9/opencode-go-autoswitch/security/advisories/new) for sensitive security findings.

## Proposing a change

Keep each pull request focused on one outcome. Explain the problem, the observable behavior before and after, and how you verified it.

Behavior rules:

- Keep the selection rule in `src/select.ts` and usage polling in `src/usage.ts`. Do not duplicate either in callers.
- A change to when the plugin switches needs a test that shows the old account was still a valid choice, or that it was not.
- Never add key material to fixtures, logs, error messages, or tool output. Tests use a fake `fetch` and a fake plugin context.
- Keep the usage parser tolerant: unknown fields are fine, and a malformed or partial response becomes "usage unknown" instead of a failed request.
- Update `CHANGELOG.md` under `Unreleased` when behavior visible to users changes.
- Update `README.md` when installation, options, the tool, or limitations change. It is the English public document.

## Validation

```bash
bun install
bun run check
```

`bun run check` runs the typecheck and the test suite. To run them separately, use `bun run typecheck` and `bun test`.

## Pull requests

A useful pull request includes:

- a short, outcome-focused title;
- the reason for the change;
- the exact commands you ran and, for behavior changes, the scenario you reproduced;
- known limitations and anything you could not verify;
- real, sanitized screenshots or recordings only when they help.

Releases use semantic versions and are cut by the maintainer; contributors do not bump the version.
