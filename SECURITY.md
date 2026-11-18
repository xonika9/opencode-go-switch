# Security Policy

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, leaked credentials, or reports that contain private data.

Use [GitHub private vulnerability reporting](https://github.com/xonika9/opencode-go-autoswitch/security/advisories/new). Include:

- the affected version and the OpenCode version you run;
- the smallest reproducible example;
- realistic impact and required preconditions;
- whether any key material, request body, or other private data was exposed, without pasting the data itself;
- a suggested fix, if you have one.

The project aims to acknowledge a report within seven days. A fix or disclosure timeline depends on severity and reproducibility.

## Design boundary

The plugin reads OpenCode Go keys from OpenCode's credential store, holds them in memory, and sends them only to the configured usage endpoint and to OpenCode providers through the request hooks. Keys are never written to plugin storage, logs, notifications, tool output, errors, or tests. A report that shows otherwise is in scope.

## Supported versions

Security fixes target the latest release. Older versions may receive guidance but are not maintained as separate branches.

## Scope

Reports about this repository's plugin code, selection and retry behavior, usage parsing, notification path, and documented installation are in scope. Vulnerabilities in OpenCode itself, the Go usage endpoint, or the provider API belong to their maintainers; this project can only address its own handling.
