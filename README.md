# HMDA — US mortgage applications at loan level

Every mortgage application US lenders were required to disclose under the Home
Mortgage Disclosure Act, 2018–2025: who applied, what happened, for how much,
by lender, county and census tract. Roughly 99 fields per record.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1573+ live data sources.

This is the dataset behind fair-lending analysis — it exists so that denial
patterns across race, ethnicity, sex and geography are checkable rather than
asserted.

## Auth

**None.** The CFPB/FFIEC Data Browser API is public and keyless.

## Tools

| Tool | Use it when |
|---|---|
| `hmda_lender_activity` | You have a lender's **LEI** and want its year |
| `hmda_geography_activity` | You want a **county or state**, optionally split by race, ethnicity, sex, purpose or loan type |
| `hmda_loan_records` | You need the **individual applications**, not the totals |
| `hmda_lenders_in_county` | You want to know **who lends here**, ranked |

Lenders are identified by LEI, not name — `resolve_entity({type:"company"})`
maps a name to one. Counties are 5-digit FIPS (`06037`, not "Los Angeles").

## Why there is no ingest

This pack was specced as a bulk load: ~15M records a year, 12–18 GB of
Postgres, an R2/Postgres column split, possibly a database tier upgrade.

None of it was needed. The Data Browser API answers the reverse queries
directly and keylessly — `view/aggregations` groups on any dimension you pass,
`view/csv` streams loan-level rows — so the pack proxies live data and hosts
nothing. Measured 2026-08-25.

The ticket's blocker was that `ffiec.cfpb.gov/static/prod/snapshot-data/…`
returns HTTP 200 with a 3 KB SPA shell and the S3 path 403s. Both are true, and
neither matters: the bulk files are not the interface. The API is documented at
[`/documentation/api/data-browser/`](https://ffiec.cfpb.gov/documentation/api/data-browser/).

## Caveats worth passing to a user

- **HMDA is a disclosure regime, not a census of lending.** Institutions below
  the reporting thresholds never appear. A lender absent from a year did not
  file; that is not the same as doing no lending.
- **A denial is the lender's coded reason**, not an adjudicated finding. The
  data supports asking whether patterns differ across groups; it does not by
  itself establish why.
- **Dollar volume is the sum of loan amounts**, not balances outstanding.
- **Lender identity is a filter upstream, not a grouping.** You can ask what one
  lender did in a county; the API cannot ask a county to rank its lenders.
  `hmda_lenders_in_county` does it by reading the county's records directly,
  which is bounded — a very large county is sampled and the response says so.
  A complete ranking needs a precomputed lender-by-county aggregate
  (~775k rows/year, tens of MB), which this pack deliberately does not carry.

## Data source

CFPB / FFIEC HMDA Data Browser API — `https://ffiec.cfpb.gov/v2/data-browser-api/`.
Public domain, US federal government work.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hmda": {
      "url": "https://gateway.pipeworx.io/hmda/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hmda/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1573+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "hmda": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hmda"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-hmda
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hmda data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
