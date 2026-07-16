# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`mailgun-ghost-throttle-proxy` is a Mailgun-compatible HTTP proxy that sits between Ghost (a blogging platform) and real Mailgun. Ghost sends bulk newsletter batches to this proxy; the proxy enqueues them in Redis via BullMQ and drips chunks to real Mailgun at a configurable rate (default: 200 recipients/hour).

## Architecture

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

**Two runtime processes:**
- **proxy** — Express server accepting Ghost's requests, splitting recipient lists into `CHUNK_SIZE` chunks, enqueuing jobs, and returning an immediate `200 { id, message: "Queued. Thank you." }` response. Also passes `GET /v3/:domain/events` straight through to real Mailgun.
- **worker** — BullMQ worker draining the queue under a rate limiter capped at `ceil(TARGET_PER_HOUR / CHUNK_SIZE)` jobs/hour.

**Key env vars:**
- `MAILGUN_API_KEY` / `MAILGUN_BASE_URL` — real Mailgun credentials
- `PROXY_API_KEY` — shared secret Ghost sends as its Mailgun API key
- `TARGET_PER_HOUR` — recipient throughput cap (default 200)
- `CHUNK_SIZE` — recipients per queued job (default 10)

## Running

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
curl http://localhost:3000/healthz
```

Watch worker output: `docker compose logs -f worker`

## Key Behaviors to Preserve

- `recipient-variables` (Ghost's per-member merge tags for unsubscribe links) must be preserved per chunk.
- The proxy must respond immediately with a Mailgun-shaped 200 so Ghost marks sends as successful.
- Queued jobs must survive worker restarts via persistent Redis volume.
- Events passthrough (`GET /v3/:domain/events`) must proxy to real Mailgun so Ghost stats work.
