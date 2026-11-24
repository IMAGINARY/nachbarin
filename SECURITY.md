# Security policy

This repository is the source of a live service: Imaginary gGmbH runs it to collect data from museum exhibits. A vulnerability here can affect data that is already stored.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub's [private vulnerability reporting](https://github.com/IMAGINARY/nachbarin/security/advisories/new) ("Report a vulnerability" on the Security tab).

Please include what you found, how to reproduce it, and what you think the impact is. Test only against a local copy (`npm run dev`), never against our deployment, and do not access, change or delete data that is not yours.

We will acknowledge the report, keep you informed while we fix it, and credit you when it is disclosed if you want to be credited.

## Scope

In scope: the Worker in `src/`, the client library in `packages/client/`, and the operator CLI in `scripts/`.

Known and documented, so not a vulnerability in itself:

- A write key is readable by anyone with access to the kiosk browser it is installed in. The design limits what such a key can do: it can only write, and only to one installation. It cannot read anything.
- The service has no rate limiter of its own (see `CLAUDE.md`). A report of a concrete way to abuse that is still welcome.
