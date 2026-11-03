# broker-next

The BGPKIT Broker collector-status page: one static Worker, no build step. `public/` holds the
page, `wrangler.toml` declares the two environments.

| Environment | Worker | Hostname |
| --- | --- | --- |
| default | `broker-next` | `broker.bgpkit.com` |
| `--env dev` | `broker-next-dev` | `dev.broker.bgpkit.com`, `broker-next-dev.bgpkit.workers.dev` |

```sh
npx wrangler deploy --env dev    # preview
npx wrangler deploy              # production hostname
```

What each block of the page reads, the health rules, and what is still missing before it can
replace the old status page are in `CUTOVER.md`.
