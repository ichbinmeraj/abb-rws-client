# RWS conformance

Does the client cover what the controllers actually advertise? This diffs the
path tables in `src/paths` against a live crawl of each controller's resource
tree. Regenerate with `npm run conformance`.

**226 implemented · 5 deliberate-gap · 0 unmapped · 0 orphan** (resource families, from the last crawl, 2026-10-10)

The counts are of resource **families**, not nodes: a node whose path holds an
instance name (a hardware device or device property under `/rw/devices`, a
RAPID task, mechanical unit, axis, I/O network or device, a configuration or
mastership domain) counts once with the family, with the name as a parameter.
The 634 advertised nodes of both generations fall into 231 families.
A family any crawled build advertises must be claimed.

| Build | Nodes | Families | Implemented | Gap | Unmapped | Crawl |
|---|---|---|---|---|---|---|
| rws2 RW 7.21.0+229 :19985 | 276 | 147 | 145 | 2 | 0 | complete (299 probed, 32 s, /rw/system after: 200) |
| rws2 RW 8.1.1+614 :9403 | 386 | 152 | 150 | 2 | 0 | complete (445 probed, 49 s, /rw/system after: 200) |
| rws1 RW 6.16.3007 :23280 | 232 | 74 | 71 | 3 | 0 | complete (250 probed, 27 s, /rw/system after: 200) |
| rws2 RW 7.21.4+417 :9403 | 269 | 117 | 116 | 1 | 0 | complete (298 probed, 33 s, /rw/system after: 200) |
| rws2 RW 8.2.1+1023 :5466 | 71 | 65 | 64 | 1 | 0 | not live today: kept from the 2026-10-10 crawl, completeness not recorded |

- **implemented** — a table entry claims the family: one at that path
  (exact), one under it (beneath: the client does something in it), or one
  above it (ancestor: the entry's resource lists or acts on it). Families
  the tables do not name but the client reads (`/rw/retcode`, the
  `/rw/devices` tree) are claimed in `scripts/conformance-classify.mjs`
  with the methods that read them.
- **deliberate-gap** — claimed as a gap, with the reason below.
- **unmapped** — the controller advertises it and nothing claims it. This is
  the drift the check exists to catch: a new endpoint after a RobotWare
  upgrade, or one the client never wrapped.
- **orphan** — a table entry whose path no controller advertises. A typo, or an
  endpoint ABB removed.

## RWS 1.0 (IRC5)

71 implemented (2 of them through an ancestor entry only) · 3 deliberate-gap · 0 unmapped · 0 orphan, over 232 nodes.

| Family | Nodes | Verdict | Claimed by / reason |
|---|---|---|---|
| `/ctrl/options` | 1 | gap | ctrl.ctrlOptionsVerify — the bare GET carries no option list (204); the list is /rw/system/options (listControllerOptions). ABB documents a per-option check, GET /ctrl/options/{option}; it is not wrapped |
| `/rw/rim` | 1 | gap | RobotWare installation service (default license, default settings, systems, boot server). Not in the RWS 1.0 reference, answers XHTML only (no JSON form), and installs systems rather than operating one. |
| `/rw/rim/infra` | 1 | gap | Part of the RobotWare installation service under /rw/rim (see there). |

## RWS 2.0 (OmniCore)

155 implemented (2 of them through an ancestor entry only) · 2 deliberate-gap · 0 unmapped · 0 orphan, over 402 nodes.

| Family | Nodes | Verdict | Claimed by / reason |
|---|---|---|---|
| `/ctrl/options` | 1 | gap | ctrl.ctrlOptionsVerify — the bare GET carries no option list; the list is /rw/system/options (listControllerOptions). ABB documents a per-option check, GET /ctrl/options/{option}; it is not wrapped |
| `/uas/configuration` | 1 | gap | usersUas.getUasConfiguration — returns the whole UAS configuration database (ABB, UAS service). UAS is administered in RobotStudio; this client reads users, roles and grants one by one (/uas/users, /uas/roles, /uas/grants) and does not export the database. Nothing is sent |

