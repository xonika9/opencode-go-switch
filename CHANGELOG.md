# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [semantic versioning](https://semver.org/).

## Unreleased

## 1.0.1 - 2026-11-18

### Changed

- When the usage endpoint stops answering during a limit, only the first account in a request waits out the two-second usage budget; later accounts in the same request go straight to the cooldown, so three limited accounts cost about two seconds instead of six.

## 1.0.0 - 2026-11-18

First release.

- Stays on the current OpenCode Go account while it has headroom in the 5-hour, weekly, and monthly windows, so ordinary requests keep the provider prompt cache.
- When that account runs out, switches to the next eligible account inside the same request and re-sends it with the new key; eligible accounts are ordered by earliest monthly reset, then those without a usable reset, then unknown usage.
- Reads usage from the Go usage endpoint and falls back to the provider's own limits: a `429`/`402` that fresh usage does not explain is left alone, and an unreadable limit, or a window still flagged after its reset time, sets the account aside for `Retry-After` or `fallbackCooldownMs`, and a later successful usage read does not shorten that.
- Marks a `401` as an invalid key, leaves `403` untouched, and declines OpenCode's retry only when every account is confirmed unusable.
- Remembers the current account across restarts, marks the active credential on every switch, and shows a toast in the terminal UI.
- Adds the `go_accounts` tool for status and explicit selection, with refusals for accounts that cannot serve a request.
- Keeps keys in OpenCode's credential store and in memory only; keys are never logged, stored, or returned, and there is no telemetry.
