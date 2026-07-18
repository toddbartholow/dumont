# Security Policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and choose **Report a vulnerability**. That opens a private advisory visible
only to the maintainers.

Include what you found, how to reproduce it, and the version or commit you tested.
You will get an acknowledgement and updates as the fix progresses.

## Scope

Dumont is a local desktop application. It opens files you choose, renders Markdown
in a webview, and auto-updates over a signed release channel. The findings that
matter most are anything that lets untrusted content (a shared document, a
downloaded theme, a configured AI endpoint) run code, read or write files outside
the open document, or defeat the update signature.

## Supported versions

Fixes land on the latest release. Please test against the newest version before
reporting.
