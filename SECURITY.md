# Security policy

## Reporting a vulnerability

Email **contact@just-edit.fr** rather than opening a public issue. Include what
you found, how to reproduce it, and what an attacker could do with it. Expect an
acknowledgement within a few days.

## Scope, honestly stated

syncto is a desktop tool that reads and writes folders you point it at. The
areas worth scrutiny:

- **SFTP credentials.** Passwords typed into a folder path (`sftp://user:pass@host/…`)
  are held in memory for the run and, if you save the job, written **in clear**
  into the `.syncto` file. Treat a job file containing a password as a secret,
  or leave the password out and rely on your SSH agent / key.
- **Host key verification.** The current SFTP backend does not pin or verify the
  server's host key. On an untrusted network, that is a real weakness — a fix is
  planned; until then prefer SFTP over networks you control.
- **Path handling.** Job files come from other people sometimes. syncto expands
  `%macros%` and `~` in paths; a malicious job file could therefore point at any
  folder your user account can reach. Read a job file before running it, the same
  way you would read a script.
- **Checksums.** xxHash detects accidental corruption, not tampering. If you need
  a guarantee against deliberate modification, use SHA-256 in the PRO mode.

## Not in scope

syncto has no server, no telemetry and no account. It makes exactly one network
request on its own: fetching `version.json` from this repository at startup to
check for a newer release. That request can be avoided by running offline; it
sends nothing but the HTTP request itself.
