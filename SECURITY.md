# Security Policy

We take the security of Trigger.dev seriously — for both our Cloud service and self-hosted deployments. This document explains how to report a vulnerability and what to expect from us.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or our Discord.**

Use one of these private channels instead:

1. **GitHub (preferred):** Open a private report from the repository's **Security** tab — click **"Report a vulnerability"** ([direct link](https://github.com/triggerdotdev/trigger.dev/security/advisories/new)).
2. **Email:** `security-advisories@trigger.dev`

Please include as much of the following as you can:

- A description of the vulnerability and its impact
- Steps to reproduce, ideally with a proof of concept
- Affected version(s) and component(s)
- Any suggested remediation

If you report by email, we will open a private GitHub Security Advisory to track the issue. All reports — however they reach us — are tracked there.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | within 3 business days |
| Validation and severity assessment (CVSS 3.1) | within 1 week |

We assess severity using CVSS 3.1 and prioritise remediation accordingly:

| Severity (CVSS 3.1) | Target time to resolve |
| --- | --- |
| Critical (9.0–10.0) | 7 days |
| High (7.0–8.9) | 30 days |
| Medium (4.0–6.9) | 90 days |
| Low (0.1–3.9) | As needed |

These are best-effort targets, measured from the point we validate and accept a report — not guarantees. Real-world exploitability may lead us to escalate an issue beyond its base score.

## Coordinated disclosure

We follow coordinated disclosure. Please give us a reasonable opportunity to investigate and ship a fix before any public disclosure. Our default disclosure window is 90 days from acceptance, though we aim to resolve issues sooner.

Once a fix is released we publish a GitHub Security Advisory (and request a CVE where applicable), and we credit reporters unless you ask to remain anonymous.

## Supported versions

We patch the **latest released version line** only. Self-hosters should run the latest version-tagged release to receive security fixes. See the [self-hosting documentation](https://trigger.dev/docs/self-hosting/overview).
