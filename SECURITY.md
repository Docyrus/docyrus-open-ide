# Security Policy

## Supported versions

Only the latest release of Docyrus Open IDE receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/Docyrus/docyrus-open-ide/security/advisories/new),
or email **security@docyrus.com**.

Please include:

- what an attacker can do, and the impact
- the steps or a minimal project that reproduces it
- the app version (`Docyrus Open IDE.app` → About, or `app.json`) and your macOS version

We aim to acknowledge a report within three business days and to ship a fix or a
mitigation plan within 30 days. We will credit you in the release notes unless
you ask us not to.

## Scope notes

This app runs local WebViews that talk to a native core over a bridge. Reports
that are especially in scope:

- a path that escapes the active project root through a `workspace.*` bridge command
- a bridge command reachable from an unexpected WebView origin or webview label
- WebView content that can navigate outside `zero://app` or reach the network
- anything that lets an opened file execute code outside the editor sandbox

Out of scope: the unsigned-binary quarantine warning on first launch (this is a
known property of the current preview build), and vulnerabilities in Monaco,
Ghostty, or the Native SDK itself — report those upstream, though we appreciate
a heads-up.
