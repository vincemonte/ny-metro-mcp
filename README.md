# MTA Transit MCP

A remote MCP server that gives Claude realtime **NYC subway** and **LIRR** data:
next trains between LIRR stations, subway arrival boards, and service alerts.
Built as a Next.js app so it deploys to Vercel's free plan in one command.

## Tools

| Tool | What it does |
|---|---|
| `lirr_next_trains` | Upcoming LIRR departures between two stations, with delays, from the realtime feed |
| `subway_arrivals` | Realtime arrivals at a subway station, grouped by direction, optional route filter |
| `service_alerts` | Current subway or LIRR alerts (delays, active disruptions), optional route filter |
| `lirr_schedule` | **Plan ahead:** scheduled trains for any date, with `depart_after` / `arrive_by` queries |
| `lirr_first_last_train` | First and last train of a service day ("when's the last train home?") |
| `planned_service_changes` | Upcoming planned work / service changes over the next N days |

Station names are fuzzy-matched ("Penn", "GCM", "Astoria Ditmars" all work), and
ambiguous names return the candidate list so Claude can self-correct.

## Setup

```bash
npm install

# Download official MTA static data (station names/ids) into /data.
# Required before first deploy — the tools error clearly until this runs.
npm run build:data

npm run dev   # local server at http://localhost:3000, MCP endpoint at /mcp
```

The realtime feeds (subway + railroad GTFS-RT) are fetched at request time and
**don't require an MTA API key**. `build:data` pulls two public datasets:
the LIRR static GTFS zip and the MTA Subway Stations CSV. If MTA moves either
URL, update the lists at the top of `scripts/build-stations.mjs` — that and
`lib/feeds.ts` are the only places URLs live.

## Test locally

With the dev server running:

```bash
npx @modelcontextprotocol/inspector
```

Choose "Streamable HTTP" and connect to `http://localhost:3000/mcp`. You can
call each tool by hand and eyeball the responses before deploying.

## Deploy to Vercel

```bash
npm i -g vercel   # if you don't have it
vercel            # first deploy; accept defaults
vercel --prod
```

Make sure you ran `npm run build:data` first and committed the `/data` JSON
files — they're bundled into the deployment.

Your MCP endpoint is `https://<your-app>.vercel.app/mcp`.

## Add to claude.ai (you + coworkers)

**Personal accounts (Free/Pro/Max):**
1. claude.ai → **Settings → Connectors**
2. **Add custom connector**
3. Paste `https://<your-app>.vercel.app/mcp` → **Add**
4. In a chat: **+** button → **Connectors** → toggle it on

**Team/Enterprise accounts:** an org **Owner** must first add the connector
under **Organization settings → Connectors**; then each member connects to it
individually the same way as above.

The root page of the deployment (`https://<your-app>.vercel.app/`) shows these
instructions, so you can just send coworkers the link.

## Notes & gotchas

- **Transport:** Streamable HTTP via [`mcp-handler`](https://www.npmjs.com/package/mcp-handler)
  (Vercel's MCP adapter). No Redis needed. Don't switch to SSE — it's deprecated
  and requires Redis on Vercel.
- **Auth:** none. The data is public and there's nothing sensitive here. If you
  ever want to lock it down, the claude.ai connector UI only supports OAuth
  (not API-key headers) — `mcp-handler` has an auth wrapper if you go that route.
- **Feed quirks:** the LIRR realtime feed only covers trips in roughly the next
  few hours; "no trains found" late at night usually means exactly that. Subway
  platform directions are GTFS N/S, which don't always match "uptown/downtown"
  intuition at every station — the `to <terminal>` destination is authoritative.
- **Schedule tools:** `lirr_schedule` / `lirr_first_last_train` query a compact
  index built from the static GTFS (`data/lirr-schedule.json`, ~5-15 MB,
  read via `fs` at runtime and bundled through `outputFileTracingIncludes`).
  They find **direct trains only** — no Jamaica-transfer routing — and only
  cover the date range of the published GTFS (a few months out). Re-run
  `npm run build:data` occasionally (or in a cron/CI job) to keep timetables
  fresh, especially after MTA schedule changes.
- **Why no subway schedule tool:** subway service is frequency-based; planning
  ahead there is about *planned work*, which `planned_service_changes` covers.
- **Cold starts:** first call after idle takes a couple of seconds; feeds are
  cached in-memory for ~25s per warm instance.
