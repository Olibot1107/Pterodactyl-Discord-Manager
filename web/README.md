# Web Status API (API-only)

This folder runs a small HTTP service that:
- Pulls node metadata from the Pterodactyl **Application API**
- Probes each node’s Wings endpoint (`/api/system`) on an interval
- Exposes the results as **JSON** (no HTML dashboard)

## Run

```bash
cd /Users/olie/Desktop/Pterodactyl-Discord-Manager
npm run start:web
```

Optional:
- `STATUS_PORT=3000` (default `3000`)

## CORS

Responses include permissive CORS headers:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET,OPTIONS`

## Endpoints

- `GET /api/health`
  - Service + monitor metadata (no nodes)

- `GET /api/nodes?range=24h|7d&include=history,historyRaw,uptimeBars`
  - List nodes with status/metrics
  - `include=history` returns downsampled `history`
  - `include=historyRaw` returns full `historyRaw` (bigger payload)
  - `include=uptimeBars` returns `uptimeBars` buckets

- `GET /api/nodes/:id?range=24h|7d`
  - Single node (always includes downsampled `history`; add `include=historyRaw` if needed)

- `GET /api/status?range=24h|7d&include=...`
  - Same as `/api/nodes` but also includes service stats + `summary`

## Quick examples

```bash
curl -s http://localhost:3000/api/health | jq
curl -s "http://localhost:3000/api/status?range=24h&include=history,uptimeBars" | jq
curl -s "http://localhost:3000/api/nodes/1?range=7d" | jq
```

## Node JSON shape (high level)

Each node looks like:
- `panel`: node details from Pterodactyl (fqdn, ports, alloc settings, etc.)
- `resources`: memory/disk in MB + GB
- `probe`: what URL/host is being checked
- `status`: `state` (`operational|maintenance|offline|unknown`), `sinceAt`, `checkedAt`, `latencyMs`, `statusCode`, `error`, last online/offline times
- `metrics`: uptime %, downtime, incidents, window info
- `history` / `historyRaw` / `uptimeBars` (optional via `include=...`)

