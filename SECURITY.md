# Security policy

## Supported versions

Only the latest minor release of vetkit receives security fixes.

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting:
https://github.com/MelsovCOZY/vetkit/security/advisories/new

Do not open a public issue or pull request for a vulnerability, and do not paste API keys, tokens
or judge request/response bodies into a report.

## Timeline

- Acknowledgement within 3 business days.
- Triage (accepted, needs more information, or declined) within 7 days.
- Fix or mitigation target within 90 days.

## Disclosure and credit

We disclose a fix through a GitHub security advisory once a patched release is available, or at
90 days at the latest. Reporters are credited in the advisory unless they ask to stay anonymous.

## Scope notes

- Judge request and response bodies are never logged. A report that shows a body in any output
  is in scope.
- Report any API key or token that appears in output, logs, artifacts or the repository.
