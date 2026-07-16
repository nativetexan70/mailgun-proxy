# mailgun-ghost-throttle-proxy

A minimal Mailgun-compatible proxy that sits between Ghost and real Mailgun.
Ghost sends its bulk newsletter batch exactly as it always has; this proxy
accepts it instantly, splits it into small chunks, and drips those chunks out
to real Mailgun at a rate you control (default: 200 recipients/hour).

## How it works

```
Ghost  --POST /v3/{domain}/messages-->  proxy (Express)
                                            |
                                     enqueue N chunks
                                            |
                                          Redis (BullMQ)
                                            |
                                   worker (rate-limited)
                                            |
                                   real Mailgun API
```

- `proxy` accepts Ghost's request immediately and returns a Mailgun-shaped
  `200 { id, message: "Queued. Thank you." }` response, so Ghost marks the
  send as successful right away.
- The recipient list is split into chunks of `CHUNK_SIZE` (default 10) and
  each chunk becomes a queued job.
- `worker` drains the queue under a BullMQ rate limiter capped at
  `ceil(TARGET_PER_HOUR / CHUNK_SIZE)` jobs/hour — i.e. roughly
  `TARGET_PER_HOUR` recipients per hour, spread across the run instead of
  fired all at once.
- `GET /v3/:domain/events` is passed straight through to real Mailgun so
  Ghost's newsletter open/click stats keep working.

## Setup on your ZimaCube

1. Copy this folder to the host (or clone it into a new LXC/container running
   Docker), then:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env`:
   - `MAILGUN_API_KEY` / `MAILGUN_BASE_URL` — your **real** Mailgun credentials
     (use `https://api.eu.mailgun.net/v3` if your domain is EU-region).
   - `PROXY_API_KEY` — make up a long random string. This is what Ghost will
     send you as its "Mailgun API key"; it never touches real Mailgun.
   - `TARGET_PER_HOUR` — 200 to start.
   - `CHUNK_SIZE` — 10 is a reasonable default; smaller = smoother pacing,
     more total API calls to Mailgun.
3. Bring it up:
   ```bash
   docker compose up -d --build
   ```
4. Confirm it's alive: `curl http://<host>:3000/healthz`

## Wiring Ghost to the proxy

Point Ghost's bulk-email Mailgun client at your proxy instead of real
Mailgun. Set these as Docker environment variables on the **Ghost**
container (not this proxy):

```
bulkEmail__mailgun__baseUrl=http://<proxy-host>:3000/v3
bulkEmail__mailgun__apiKey=<same value as PROXY_API_KEY above>
bulkEmail__mailgun__domain=<your real sending domain, e.g. mail.pasoroblesdemocrats.org>
```

Restart the Ghost container after setting these. Send a small test
newsletter first and watch `docker compose logs -f worker` — you should see
`[queued]` from the proxy immediately, followed by `[sent]` lines trickling
in from the worker at the throttled rate.

## Notes / limitations

- This only affects **bulk newsletter sends** (Ghost's `bulkEmail` config
  tree). Transactional mail (`mail__*` — password resets, staff invites,
  member sign-in links) is unrelated and keeps going straight through your
  existing SMTP config.
- If Ghost's UI shows "sending" for longer than usual on a big list, that's
  expected — the send is now spread over `recipients / TARGET_PER_HOUR`
  hours instead of firing immediately.
- If the worker container restarts mid-send, queued-but-unsent jobs remain
  in Redis and resume automatically once the worker comes back — nothing is
  lost, but do keep the `redis-data` volume persistent (already set up in
  the compose file) rather than running Redis with `--rm`.
- `recipient-variables` (per-member merge tags Ghost uses for unsubscribe
  links etc.) are preserved per chunk, so personalization still works.
- Scale `TARGET_PER_HOUR` / `CHUNK_SIZE` up later once Mailgun's automatic
  throttle on your account lifts (domain reputation warm-up) — this proxy
  doesn't need to change, just the two env vars.
