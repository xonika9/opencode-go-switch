# Security Policy

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, leaked credentials, or reports that contain private data.

Use GitHub private vulnerability reporting through the Security tab of [xonika9/opencode-go-switch](https://github.com/xonika9/opencode-go-switch/security/advisories/new). Include:

- the affected plugin version and the OpenCode or Pi version you run;
- the smallest reproducible example;
- realistic impact and required preconditions;
- whether any key material, request body, or other private data was exposed, without pasting the data itself;
- a suggested fix, if you have one.

Never paste an API key or a key fragment into a report, a log excerpt, or a screenshot. A redacted description of where a key appeared is enough.

## Scope

Reports about this repository's code are in scope, especially:

- **Key handling.** Keys are read from the host's credential store (OpenCode's, or Pi's `auth.json`) into memory, put on provider requests, and sent to the usage endpoint. They must never be written to plugin storage, logs, notifications, tool output, errors, or tests.
- **Usage endpoint requests.** The plugin must contact only the configured `https` usage endpoint, or the https origin named in the credential's `server` metadata. Redirects must not be followed, and the body must stay capped.
- **Selection and switching.** A bug that uses the wrong account for a request, or that leaks one account's key or usage into another account's state, is in scope.

Vulnerabilities in OpenCode or Pi themselves, the Go usage endpoint, or the provider API belong to their maintainers; this project can only address its own handling.

## Supported versions

Security fixes target the latest release. Older versions may receive guidance but are not maintained as separate branches.

## Disclosure

The project aims to acknowledge a report within seven days. A fix or disclosure timeline depends on severity and reproducibility.
