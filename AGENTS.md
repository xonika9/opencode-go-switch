# opencode-go-autoswitch repository

This repository is the public source of an OpenCode V2 plugin that switches between OpenCode Go accounts. Work directly on `main`; do not create branches unless the user asks.

## Sources of truth

- `src/select.ts` owns the selection rule: window exhaustion, eligibility, sticky behavior, and the order in which the next account is chosen. Change behavior there, not in the callers.
- `src/usage.ts` owns usage polling: the endpoint request, timeout, response size cap, and tolerant parsing. An unknown shape must degrade to "usage unknown", never to a guess.
- `src/server.ts` wires hooks, the tool, notifications, and timers. Keep the wiring thin; behavior belongs in the modules above.

## Keys and privacy

- Never log, print, return, store, or commit API keys or key fragments. Read them from OpenCode's credential store into memory only.
- Keep tool output, errors, tests, and fixtures free of key material.
- Do not add telemetry or send usage data anywhere except the configured usage endpoint.

## Tests

- Tests use a fake `fetch` and a fake plugin context. No real keys, no real network.
- Run `bun run check` (typecheck plus tests) before reporting work as done. Run `bun test` while iterating.

## Documentation

- `README.md` is the English public document. Keep it accurate about current behavior and limitations, and keep it free of fabricated screenshots or numbers.
- The hero image is reserved at `assets/opencode-go-autoswitch-hero.jpg` (2:1). Leave it commented out in the README until the file exists.
- Record every user-visible change under `Unreleased` in `CHANGELOG.md` in the same task.

## Git

- Do not commit, push, tag, or publish unless the user explicitly requests it.
- Preserve unrelated and user-owned changes. Never discard work with `git checkout`, `git reset --hard`, or a similar shortcut.
