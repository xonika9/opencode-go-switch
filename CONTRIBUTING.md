# Contributing

Thanks for helping make the switch predictable. Focused fixes, reproductions, and clear behavior reports are welcome.

## Development setup

You need Bun 1.2 or newer. OpenCode itself is not required for development; the tests drive the plugin through a fake host.

```bash
git clone https://github.com/xonika9/opencode-go-switch.git
cd opencode-go-switch
bun install
bun run check
bun run build
```

`bun run check` runs the typecheck and the test suite. `bun run build` compiles `src` to `dist`, which is what the package and a locally installed clone load. To run the parts separately, use `bun run typecheck` and `bun test`.

## Where things live

- `src/select.ts` owns the selection rule: eligibility, sticky behavior, exhaustion, and the order candidates are tried in.
- `src/usage.ts` owns the usage request and parsing, including the timeout, the response size cap, and the rule that an unknown shape means unknown usage.
- `src/switcher.ts` owns state, polling, switching, and the request, response, and retry hook handlers.
- `src/status.ts` owns the text the `go_accounts` tool prints.
- `src/server.ts` is thin wiring: options, hooks, the tool, the RPC contract, and timers.
- `src/rpc.ts` and `src/tui.ts` own the switch notification.

Change behavior in its module, not in a caller, and do not duplicate the selection rule or the usage parser.

## Tests

- Use a fake `fetch` and a fake plugin context. Tests must never need a real key or a real network request.
- Never add key material, key fragments, or personal paths to fixtures, logs, error messages, or tool output.
- A change to when the plugin switches needs a test that shows the current account was, or was not, still a valid choice.
- Keep the usage parser tolerant: unknown fields are fine, and a malformed or partial response becomes unknown usage instead of a failed request.
- Run `bun test` while iterating and `bun run check` before opening a pull request.

## Pull requests

Keep each pull request focused on one outcome, and include:

- a short, outcome-focused title;
- the problem and the observable behavior before and after;
- the exact commands you ran and, for behavior changes, the scenario you reproduced;
- known limitations and anything you could not verify;
- sanitized screenshots or recordings only when they help.

Before you open it:

- update `CHANGELOG.md` under `Unreleased` for every user-visible change;
- update `README.md` when installation, options, the `go_accounts` tool, or limitations change;
- confirm the diff contains no keys, key fragments, or personal paths.

Releases use semantic versions and are cut by the maintainer; contributors do not bump the version.

## Reporting bugs and vulnerabilities

Use the issue template for ordinary bugs, and include the plugin version from the first line of `go_accounts` output. Remove keys and personal paths from everything you paste. For security findings, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
