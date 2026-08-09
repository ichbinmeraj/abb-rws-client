# RWS conformance

Does the client cover what the controllers actually advertise? This diffs the
path tables in `src/paths` against a live crawl of each generation's resource
tree. Regenerate with `npm run conformance`.

**56 implemented · 4 deliberate-gap · 0 unmapped · 0 orphan** (crawled 2026-08-09)

- **unmapped** — the controller advertises it and nothing in the tables claims
  it. This is the drift the check exists to catch: a new endpoint after a
  RobotWare upgrade, or one the client never wrapped.
- **orphan** — a table entry whose path no controller advertises. A typo, or an
  endpoint ABB removed.

## RWS 1.0 (IRC5)

Every advertised resource is claimed by a table entry.

## RWS 2.0 (OmniCore)

Every advertised resource is claimed by a table entry.

