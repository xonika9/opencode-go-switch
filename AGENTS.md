# opencode-go-autoswitch repository

This repository is the public source of an OpenCode V2 plugin that switches between OpenCode Go accounts. Work directly on `main`; do not create branches unless the user asks.

## Sources of truth

- `src/select.ts` owns the selection rule: window exhaustion, eligibility, sticky behavior, and the order in which the next account is chosen. Change behavior there, not in the callers.
- `src/usage.ts` owns the usage request and parsing: the endpoint URL and headers, timeout, response size cap, and tolerant parsing. An unknown shape must degrade to "usage unknown", never to a guess.
- `src/switcher.ts` owns runtime state, polling, switching, and the request, response, and retry hook handlers.
- `src/status.ts` owns the text the `go_accounts` tool prints. Keep its wording in sync with the states the selection rule can produce.
- `src/server.ts` is thin wiring: options, hook registration, the tool, the RPC contract, and timers. Behavior belongs in the modules above.
- `src/rpc.ts` and `src/tui.ts` own the switch notification. They carry only a label and a reason, never key material.

## Commands

- `bun run check` runs the typecheck and the test suite. Run it before reporting work as done.
- `bun run build` compiles `src` to `dist`, which is what the published package and a locally installed clone load.
- `bun test` while iterating; `bun run typecheck` alone when only types changed.

## Keys and privacy

- Never log, print, return, store, or commit API keys or key fragments. Read them from OpenCode's credential store into memory only.
- Keep tool output, errors, tests, and fixtures free of key material.
- Do not add telemetry or send usage data anywhere except the configured usage endpoint.

## Tests

- Tests use a fake `fetch` and a fake plugin context. No real keys, no real network.
- A change to selection or switching needs a test for the choice that was made and for the account that was not chosen.

## Documentation

- `README.md` is the English public document. Keep it accurate about current behavior and limitations, and keep it free of fabricated screenshots or numbers.
- The hero image is `assets/opencode-go-autoswitch-hero.jpg` (2:1), shown at the top of the README with the alt text "Go Switch: Limits hit? Keep coding."
- Update `README.md` and `CHANGELOG.md` (under `Unreleased`) in the same change as any user-visible behavior.

## Git

- Do not commit, push, tag, or publish unless the user explicitly requests it.
- Preserve unrelated and user-owned changes. Never discard work with `git checkout`, `git reset --hard`, or a similar shortcut.
