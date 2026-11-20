# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**, which uses GitHub private vulnerability reporting.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge
reports within 5 business days and to agree on a disclosure timeline with you. This is a
best-effort open-source project with no bug bounty.

## Scope

In scope: the `heedwise` package and the code in this repository. The areas that
matter most are listed below, and our threat model is in [THREAT_MODEL.md](THREAT_MODEL.md):
- prompt injection that bypasses the proxy's content controls
- forged or replayed webhook events being accepted
- leaks of tokens or secrets
- anything that lets a remote party reach the local listener

Out of scope: vulnerabilities in agent hosts (such as Claude Code), model behavior on its
own, and attacks that already require code execution on the user's machine.

## Supported versions

Only the latest released version receives security fixes during the 0.x series.

## Safe use

- Use a **fine-grained, read-only** GitHub token, scoped to the repositories you watch.
- Keep your agent host's permission prompts enabled. The proxy delivers data; it cannot
  control what an agent does with it.
- Free-text event content is off by default. Enable it only for authors you trust.

This software is provided "AS IS", without warranty of any kind, as stated in the Apache-2.0
license.
