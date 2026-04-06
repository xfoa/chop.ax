# chop.ax

Web proxy that strips bloat from pages for extremely low-bandwidth browsing. Visit `chop.ax/<url>` to get a clean, lightweight version of a page on any whitelisted domain.

## Features

- Article extraction via [Mozilla Readability](https://github.com/mozilla/readability)
- [Puppeteer](https://pptr.dev/) rendering for JS-heavy sites (Reddit, Imgur)
- Simple HTTP fetch for static sites (Wikipedia, news)
- Worker thread pool for parallel HTML cleaning
- Redis caching (1hr TTL)
- Per-user and per-IP rate limiting
- Domain whitelist

## Requirements

- [Bun](https://bun.sh)
- Redis
- Chromium (for Puppeteer)

## Setup

```
bun install
npm start
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `BROWSER_POOL` | `3` | Number of Puppeteer browser instances |
| `READER_WORKERS` | `4` | Number of worker threads for Readability HTML cleaning |
| `MAX_CONCURRENT` | `32` | Max concurrent render requests |
| `RENDER_TIMEOUT` | `10000` | Render timeout in ms |
| `RATE_WINDOW` | `60000` | Rate limit sliding window in ms |
| `RATE_PER_USER` | `10` | Max renders per user per window |
| `RATE_PER_IP` | `30` | Max renders per IP per window |
