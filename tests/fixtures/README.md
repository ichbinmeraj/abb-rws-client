# Test fixtures

## `listening-ports/`

Outputs of the OS commands and files the listening-port scan reads
(`src/discovery/listeningPorts.ts`), used by `tests/discovery/listeningPorts.test.ts`.
Provenance lives here, never inside a fixture, so every file is byte-for-byte what a
parser would see. `.gitattributes` marks these files `-text` so line endings are kept
(Windows CRLF, Linux and macOS LF).

Labels:

- **captured**: real output, recorded on 2026-10-03 on a Windows 11 PC (display
  language en-US, console code page 65001) running five RobotStudio virtual
  controllers: RobotWare 6.16.03 (port 39127), 7.21.0 (5466), 7.21.4 (9403),
  8.1.1 (80) and 8.2.1 (9805). Trimmed to the rows a test needs. The PC's network
  address is replaced with the documentation address 192.0.2.10 (RFC 5737), and
  every process ID except the System process (4) is replaced with a made-up one,
  the same in every fixture (2101-2105: the five controllers, 1001: RPC endpoint
  mapper, 3001: a non-controller process bound to ::1 only).
- **documented**: rows as printed in a public source, named below.
- **derived (synthetic)**: composed by hand from the format the named source
  defines; not a capture. Addresses that are not loopback or wildcard are RFC 5737
  documentation addresses.

| File | Label | Source and notes |
|---|---|---|
| `win-netstat-ano.txt` | captured | `netstat -ano`. Kept: the controllers' listening rows (each RWS port on both `0.0.0.0` and `[::]`; each controller's second, IPv4-only port), ports 135 and 445, one established connection, the LAN-only `:139` row, one row bound to `[::1]` only, one UDP row. |
| `win-netstat-ano-p-tcp.txt` | captured | `netstat -ano -p TCP`, same rows where present. Pair with the file above: `-p TCP` lists IPv4 only, so the `[::1]`-only row is missing here. |
| `win-get-nettcpconnection-listen.json` | captured | `Get-NetTCPConnection -State Listen \| Select-Object LocalAddress,LocalPort,OwningProcess \| ConvertTo-Json -Compress`, same ports. The dual-stack controller ports appear only as `::`, with no `0.0.0.0` row. |
| `win-netstat-ano-de-cp850.txt` | derived (synthetic) | German Windows `netstat -ano`. Headers from German Windows guides (windows-faq.de); state words `ABHÖREN` and `HERGESTELLT` as recorded from real German agent output by the Checkmk `win_netstat` check (lists.checkmk.com, checkmk-commits, 2013), where `Ö` arrives as the single OEM code page 850 byte 0x99, kept as that byte here. The `:135` listener and the established `:445` row follow the Checkmk sample rows (addresses changed to RFC 5737); the other rows follow this package's earlier hand-written German sample. No live German capture exists. |
| `ss-modern.txt` | documented + derived | Rows 1-2 (`127.0.0.53%lo:53`, `0.0.0.0:22`) as in a public `ss` output on bbs.archlinux.org (topic 292291, 2024-01). Rows 3-6 (`[::]`, `*`, `[::ffff:127.0.0.1]`, `[::1]`) derived from iproute2 `misc/ss.c` (v4.14 and later address forms). |
| `ss-old.txt` | derived (synthetic) | iproute2 up to v4.12 (`misc/ss.c`): IPv4 any as `*`, IPv6 not bracketed (`:::22`, `::1:631`, `::ffff:127.0.0.1:9403`); shape as in public CentOS 7 / RHEL 7 outputs. |
| `ss-netid-estab.txt` | derived (synthetic) | Netid column, and an established row inside a listening listing. The `tcp LISTEN 0 128 *:22 *:*` row shape is as shown on access.redhat.com (solution 2200061), which documents that some RHEL 7 `ss` builds print established rows under `-l` with a filter; the `ESTAB` row text is composed. |
| `ss-no-state.txt` | derived (synthetic) | iproute2 2.6.39 prints no State column (public output quoted on lists.gnupg.org, gnutls-devel, 2019-11). |
| `proc-net-tcp.txt` | derived (synthetic) | Linux `/proc/net/tcp`, from the print format in the kernel's `net/ipv4/tcp_ipv4.c` (little-endian CPU, lines padded to 149 characters as the kernel does): 127.0.0.1:5474, 0.0.0.0:22, 127.0.0.53:53 listening, one established row. |
| `proc-net-tcp6.txt` | derived (synthetic) | Linux `/proc/net/tcp6`, from `net/ipv6/tcp_ipv6.c`: `[::]:22`, `[::1]:631`, `[::ffff:127.0.0.1]:9403` listening, one established row. |
| `macos-netstat.txt` | derived (synthetic) | macOS `netstat -an -p tcp`, from Apple's `network_cmds` `netstat.tproj/inet.c` (`protopr`, `inetprint`) and the netstat manual at ss64.com/mac/netstat: `host.port` with a dot, Proto `tcp4`/`tcp6`/`tcp46`, `*.80`. Column widths vary by release; parsers split on whitespace. |
| `macos-lsof-F.txt` | derived (synthetic) | `lsof -nP -b -w -iTCP -sTCP:LISTEN -Fptn`, from the lsof manual, OUTPUT FOR OTHER PROGRAMS (lsof.readthedocs.io): `p`, `f`, `t`, `n` lines; address forms cross-checked with a public column-format sample (til.simonwillison.net, macos/lsof-macos). |

## `compat-1.4.0.ts`

TypeScript written against the 1.4.0 public types, compiled (never run) by
`tests/compat140.types.test.ts` against `src`, which expects no type error. It
covers the signatures changed after 1.4.0: `getCompatibility` called without a
version and read as `{ compatible, details? }`, and on an `IRWSAdapter` of
another make answering that 1.4.0 result, `registerUser` with a `string`
locale or none, `compressPath`, `decompressPath` and `saveSystemInfo` (an
`IRWSAdapter` of another make whose methods return `Promise<void>`, one that
passes an inner adapter's promise on, and callers that pass the promise on
where a `Promise<void>` is asked for), the subscription kinds and
`getRobotType`. The `@ts-expect-error` lines are controls that must stay
errors. Outside the check: a subclass of this package's adapters that
overrides a method whose result gained a field (`getCompatibility`'s
`status`, `getRobotType`'s `types`) with its 1.4.0 result type; the override
returns the new result.
