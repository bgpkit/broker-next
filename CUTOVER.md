# Cutover plan: broker.bgpkit.com as the collector-status home

Status: beta live (2026-10-19). `broker.bgpkit.com` serves the broker-status page; `status.broker.bgpkit.com`
and `ui.broker.bgpkit.com` still serve the existing SvelteKit status page.

## What the page reads

| Block | Source | Verified |
|---|---|---|
| collector catalog | `/v4/broker/collectors` | 82 rows, 76 active, 6 deactivated |
| 24h file processing | `/v4/spectrum/aggregates` (hour buckets, grouped by collector) | 79 collectors with parsed files, 12,020 files, 0 failed |
| newest file per type | `/v4/broker/latest` | 85 collectors × updates/rib |
| fleet throughput series (chart) | `/v4/spectrum/aggregates` (hour buckets, grouped by project) | 2 projects × 24 hourly buckets |
| peers (drawer) | `/v4/broker/peers?collector=` | on demand only |
| per-collector hourly series (drawer) | `/v4/spectrum/aggregates` | on demand only |

No seismo, prism or vistrack endpoints are used. Four requests on first paint (catalog, 24h collector aggregates, project series, file feed).

## Health rules

- cadence: RIPE RIS updates 5m / RIB 8h; RouteViews updates 15m / RIB 2h
- stale: newest updates older than `2 × cadence + 15m`, or newest RIB older than `2 × cadence + 30m`
  (measured publication lag is ~10m for RIS updates and ~30m for RouteViews updates, so tighter
  slack flags healthy collectors at the boundary)
- failing: no parsed file in 24h, or failed ≥ max(3, 10% of expected); degraded: any smaller failure
- retired: catalog `deactivated_on` set; not in catalog: a processed-file name the catalog lacks

## Remaining gaps before replacing the old status page

1. Per-collector file table: sizes, parse duration, delay, and download links. The old page shows
   this per collector; the study only shows counts and a sparkline. Data exists in
   `/v4/spectrum/files` and `/v4/broker/latest`.
2. Peer full-feed flag: the old page marks full-feed peers. v4 `/v4/broker/peers` returns prefix
   and connected-ASN counts only; either add the field to v4 or derive the criterion explicitly.
3. On-time statistics: the old page has an on-time panel per data type. The cadence table above is
   the basis; needs a dedicated aggregate (per collector, per type, last N intervals).
4. Cross-collector peer search: old page can filter peers across collectors; the study only shows
   one collector's peers in the drawer.

## Cutover sequence

1. Beta (done): `broker.bgpkit.com` is a custom domain on the `bgp-fyi-atlas` worker (internal name kept to avoid moving the custom domains), still reading
   `dev.api.bgpkit.com`.
2. Close gaps 1-3 above (or accept the reduced feature set explicitly).
3. Switch the page's API base to `https://api.bgpkit.com` (prod v4 serves `/v4/broker/*` and
   `/v4/spectrum/*`; `/v4/prism/prefix` is dev-only today, 404 on prod, so do not depend on it).
4. Verify on prod: catalog 82, parsed 79, latest 85 × 2, no console errors, first paint under 1s.
5. Redirect the old hosts: make `bgpkit-broker-ui` return 301 to `https://broker.bgpkit.com` for
   both `status.broker.bgpkit.com` and `ui.broker.bgpkit.com` (keep the worker deployed during the
   beta so rollback is one deploy).
6. Announce: status page URL change, update links in docs, README, API docs and the site footer.

## Rollback

- Remove the two 301 rules; the old SvelteKit page is still deployed and unchanged.
- Remove the `broker.bgpkit.com` route from `bgp-fyi-designs/broker-status/wrangler.toml` and redeploy if
  the beta must disappear entirely.
