# opencode-go-switch repository

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
- Do not add telemetry or send usage data anywhere except the configured usage endpoint, or the https origin named in a credential's `server` metadata.

## Tests

- Tests use a fake `fetch` and a fake plugin context. No real keys, no real network.
- A change to selection or switching needs a test for the choice that was made and for the account that was not chosen.
- For a live `opencode run` with test-only plugin options, set `OPENCODE_CONFIG_DIR` to an empty directory together with `OPENCODE_CONFIG_CONTENT`. `OPENCODE_CONFIG_CONTENT` alone layers on top of the user's config, so a plugin listed in both loads twice and every switch is handled twice. Rebuild `dist` first; a `file://` entry loads the compiled package.

## Documentation

- `README.md` is the English public document. Keep it accurate about current behavior and limitations, and keep it free of fabricated screenshots or numbers.
- The hero image is `assets/opencode-go-switch-hero.jpg` (2:1), shown at the top of the README with the alt text "Go Switch: Limits hit? Keep coding."
- Update `README.md` and `CHANGELOG.md` (under `Unreleased`) in the same change as any user-visible behavior.

## Git

- Do not commit, push, tag, or publish unless the user explicitly requests it.
- Preserve unrelated and user-owned changes. Never discard work with `git checkout`, `git reset --hard`, or a similar shortcut.

<!-- x9-context-files-generator:execution:start -->
## Execution discipline

Shared defaults from the `x9-context-files-generator` template. Repository-specific instructions outside this block take precedence. Local contains optional pointers to existing project resources.

- Use the project's existing verification tools. Do not build a separate acceptance framework merely to verify a routine change.
- After a check fails, run the failing check and checks affected by its fix. Repeat a previously passing check when the change could invalidate its result or the project requires a fresh run.
- Keep code comments focused on non-obvious reasons, invariants, and workarounds. Preserve license notices and useful API documentation; avoid narrating the code.

<!-- x9-context-files-generator:execution:end -->

<!-- x9-context-files-generator:documentation:start -->
## Documentation discipline

Shared defaults from the `x9-context-files-generator` template. Repository-specific instructions outside this block take precedence. Local contains optional pointers to existing project resources.

- Update current documentation affected by a change. Preserve historical plans and research as historical evidence rather than silently rewriting them to describe the present.
- Keep setup and verification procedures in their existing scripts or documentation, with concise entry points in README or agent instructions where useful.
- Keep current work status in its existing home; do not maintain competing status summaries across documents.
- For documentation-only changes, run the applicable documentation checks and inspect changed repository-relative links. Run code checks when the change affects what they verify.
- Use a tool's configured artifact location instead of creating a parallel directory.

<!-- x9-context-files-generator:documentation:end -->
