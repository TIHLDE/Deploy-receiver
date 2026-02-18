# Security Policy

## Supported versions

Only the latest release on the `main` branch is supported with security updates.

## Reporting a vulnerability

If you discover a security vulnerability in this repository, **please do not open a public issue**.

Instead, report it privately:

1. **GitHub Security Advisories (preferred):** Go to the [Security Advisories](https://github.com/TIHLDE/workflows/security/advisories) tab and click **"Report a vulnerability"**.
2. **Email:** Send details to TIHLDE via <https://tihlde.org>.

## Scope

This service authenticates and executes deploy scripts on a server. Security concerns include:

- Bypass of token authentication
- Path traversal or injection via repo slugs
- Credential leakage in logs or process environment
- Unauthorised script execution
