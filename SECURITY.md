# Security Policy

## Supported versions

Only the latest published version receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/ichbinmeraj/abb-rws-client/security/advisories/new)
rather than opening a public issue. You should receive a response within a week.

## Scope notes

This library talks to industrial robot controllers. Anything that could allow an
unauthorized party to move a robot, alter RAPID programs, or intercept controller
credentials is in scope — including TLS/certificate handling, credential storage,
and authentication flows.
