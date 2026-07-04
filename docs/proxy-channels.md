# Proxy Channels

The metadata worker works without proxies. Every outbound read starts with a normal Worker `fetch()` unless its domain policy sets `proxyMode` to `required`. Proxy channels are otherwise tried after the direct request returns a retryable status such as `429`, `403`, `503`, after a retryable network failure, or after parsed metadata matches a configured challenge signature.

This keeps the fast path fast, keeps costs low, and lets OSS users opt in to the proxy pattern that fits their deployment.

For the full request story, queue lifecycle, and failure-mode map, see [Metadata API Architecture](metadata-api-architecture.md).

## Ingestion Flow

This worker uses the same metadata pipeline for fresh imports and manual refreshes.

```mermaid
sequenceDiagram
  participant Extension
  participant Worker
  participant Cache as Cache/KV
  participant Queue
  participant Throttle as Domain Throttle DO
  participant Origin

  Extension->>Worker: GET /?url=... repeated for imported tabs
  Worker->>Cache: read metadata for every URL
  Cache-->>Worker: cached hits + misses
  Worker-->>Extension: cached metadata + queued placeholders
  Worker->>Queue: enqueue missing hydrate jobs
  Queue->>Throttle: acquire per-domain slot
  Throttle-->>Queue: delay budget
  Queue->>Origin: direct fetch or policy-required proxy
  Queue->>Cache: write hydrated metadata
  Extension->>Worker: GET /?url=...&co=1
  Worker-->>Extension: hydrated metadata when ready
```

ASCII version:

```text
100 imported tabs
  |
  v
extension creates local items immediately
  |
  v
metadata worker checks Cache/KV
  |
  +-- cached -------------------------------> return metadata now
  |
  +-- missing/stale ------------------------> enqueue metadata job
                                                |
                                                v
                                      domain throttle by host
                                                |
                                                v
                                      direct fetch -> proxy fallback
                                                |
                                                v
                                      write Cache/KV
                                                |
                                                v
extension polls cache-only endpoint and updates cards
```

Small requests, currently one or two URLs, can hydrate inline. Larger requests return quickly and queue missing URLs.

## Proxy Fallback Flow

```mermaid
flowchart TD
  A[Metadata request] --> B[Direct Worker fetch]
  B -->|2xx/3xx/non-retryable| P[Parse metadata]
  P -->|accepted| C[Return direct response]
  P -->|rejected by policy| D
  B -->|retryable status or network failure| D{Proxy enabled for purpose?}
  D -->|No| E[Return direct response or error]
  D -->|Yes| F[Load ordered proxy channels]
  F --> G{Channel matches domain and purpose?}
  G -->|No| H[Try next channel]
  G -->|Yes| I[Fetch through channel]
  I -->|Success| J[Return proxy response]
  I -->|Retryable status/error| H
  H --> K{More channels?}
  K -->|Yes| G
  K -->|No| E
```

ASCII version:

```text
request
  |
  v
direct fetch
  |
  +-- success/non-retryable ------------------> return direct
  |
  +-- retryable status/network failure
        |
        v
    enabled purpose?
        |
        +-- no -------------------------------> return direct/error
        |
        +-- yes
              |
              v
          channel 1 -> channel 2 -> channel N
              |            |            |
              +-- match purpose/domain and fetch
                          |
                          +-- success -> return proxy
                          +-- fail ----> next channel
```

## Environment Variables

| Variable | Type | Required | Purpose |
| --- | --- | --- | --- |
| `METADATA_POLICY_JSON` | var/secret string | No | Metadata API limits, queue timing, domain buckets, throttle leases, priorities, and per-domain user-agent/image-rewrite policy. |
| `PROXY_CHANNELS_JSON` | secret string | No | Ordered channel config. If missing, the worker never uses proxies. |
| `PROXY_FALLBACK_STATUSES` | var string | No | Comma-separated HTTP statuses that trigger fallback. |
| `PROXY_ENABLED_PURPOSES` | var string | No | Comma-separated purpose allow-list. If missing, channel-level purpose rules decide. |
| `DATAIMPULSE_USERNAME` | secret string | DataImpulse only | DataImpulse proxy username. |
| `DATAIMPULSE_PASSWORD` | secret string | DataImpulse only | DataImpulse proxy password. |
| `DATAIMPULSE_PROXY_URL` | secret string | Optional | Full `http://user:pass@host:port` proxy URL if you prefer one secret. |

Set `proxyMode: "required"` in a domain rule when direct Worker egress is known to receive a challenge page. Required-proxy requests fail rather than silently retrying direct egress.

Worker `fetch()` is not an anonymity layer. Cloudflare documents that a `CF-Worker` header is added to Worker subrequests, so the only reliable way to avoid direct Worker egress for a domain is to route that domain through a configured proxy or service channel. The worker still sends normal HTML document request headers for metadata reads, but it does not try to spoof impossible network identity.

Supported purposes:

```text
metadata-html  HTML pages for Open Graph metadata
media-import   remote media copied into R2
ocr-image      image proxy reads for OCR
	r2-image       remote image reads before R2 rewrite
```

For HTTPS targets on Workers, prefer a `socks5` channel when the provider offers one. It carries TLS within the tunnel and avoids relying on a native TLS upgrade after an HTTP CONNECT tunnel.

Recommended starting point:

```json
{
  "PROXY_ENABLED_PURPOSES": "metadata-html"
}
```

Only widen to images/media after measuring bandwidth.

## Metadata Policy

The metadata API core does not hardcode special domains. Domain behavior lives in `METADATA_POLICY_JSON`; if it is missing or invalid, the worker uses conservative generic defaults.

Use this policy for API limits, queue timing, domain aliases, throttle leases, queue priorities, and rare per-domain fetch behavior:

```json
{
  "inlineLimit": 2,
  "maxUrlsPerRequest": 100,
  "defaultPollAfterSeconds": 30,
  "defaultPriority": {
    "hydrate": 5,
    "refresh": 3
  },
  "queue": {
    "lockTtlSeconds": 1200,
    "retryFallbackSeconds": 60
  },
  "throttle": {
    "default": {
      "intervalMs": 300,
      "maxConcurrent": 4,
      "leaseTtlMs": 30000,
      "maxDelayMs": 30000
    },
    "domains": [
      {
        "match": ["example.com", "*.example.org"],
        "bucket": "example-family",
        "throttle": {
          "intervalMs": 1000,
          "maxConcurrent": 2
        },
        "pollAfterSeconds": 20,
        "priority": 8,
        "userAgent": "MetadataBot/1.0",
        "rewriteImagesToR2": false,
        "proxyMode": "required",
        "rejectMetadataTitleIncludes": ["please wait for verification"]
      }
    ]
  },
  "proxyBudget": {
    "maxRequestsPerMinute": 100,
    "maxRequestsPerDay": 10000,
    "maxFailuresBeforeCooldown": 20
  }
}
```

Policy fields:

- `inlineLimit`: maximum URLs fetched inline. Bigger requests return queued placeholders.
- `maxUrlsPerRequest`: hard request cap. The worker returns `400` instead of silently dropping extra URLs.
- `defaultPollAfterSeconds`: fallback `Retry-After` hint for queued placeholders.
- `defaultPriority`: recorded priority for future queue splitting or schedulers.
- `queue.lockTtlSeconds`: dedupe lock TTL for queued work.
- `queue.retryFallbackSeconds`: retry delay when an origin/proxy error is retryable but has no `Retry-After`.
- `throttle.default`: default per-bucket interval and max-concurrency lease rule.
- `throttle.domains[].match`: exact domain, parent-domain, or `*.suffix` match.
- `throttle.domains[].bucket`: shared throttle bucket for aliases or domain families.
- `throttle.domains[].userAgent`: optional user-agent override.
- `throttle.domains[].rewriteImagesToR2`: opt-in metadata image rewriting for that domain family.
- `throttle.domains[].proxyMode`: `required` skips direct Worker egress and fails if no proxy channel succeeds; omit it for normal direct-then-fallback behavior.
- `throttle.domains[].rejectMetadataTitleIncludes`: lowercased title fragments which mark a response as a challenge/error page. Rejected results are not cached.
- `proxyBudget`: parsed config hooks for quota/circuit-breaker enforcement. Billing-grade enforcement is intentionally a later layer.

Store large policy JSON as a secret if it contains provider or customer-specific strategy:

```bash
npx wrangler secret put METADATA_POLICY_JSON
```

## Channel Types

### `dataimpulse`

First-class shortcut for DataImpulse residential proxies. It defaults to:

```text
host: gw.dataimpulse.com
port: 823
protocol: HTTP CONNECT
```

Set secrets:

```bash
npx wrangler secret put DATAIMPULSE_USERNAME
npx wrangler secret put DATAIMPULSE_PASSWORD
npx wrangler secret put PROXY_CHANNELS_JSON
```

Example `PROXY_CHANNELS_JSON`:

```json
{
  "channels": [
    {
      "name": "dataimpulse-residential",
      "type": "dataimpulse",
      "purposes": ["metadata-html"],
      "domains": ["hard-to-fetch.example", "media-site.example"],
      "connectTimeoutMs": 8000,
      "readTimeoutMs": 15000,
      "maxBodyBytes": 5242880
    }
  ]
}
```

You can also use a single proxy URL secret:

```json
{
  "channels": [
    {
      "name": "dataimpulse-residential",
      "type": "dataimpulse",
      "proxyUrlEnv": "DATAIMPULSE_PROXY_URL",
      "purposes": ["metadata-html"]
    }
  ]
}
```

`DATAIMPULSE_PROXY_URL` format:

```text
http://USERNAME:PASSWORD@gw.dataimpulse.com:823
```

### `socks5`

Use this for providers with SOCKS5 access. DataImpulse's rotating SOCKS5 endpoint is `gw.dataimpulse.com:824`.

```json
{
  "channels": [
    {
      "name": "dataimpulse-residential-socks",
      "type": "socks5",
      "host": "gw.dataimpulse.com",
      "port": 824,
      "usernameEnv": "DATAIMPULSE_USERNAME",
      "passwordEnv": "DATAIMPULSE_PASSWORD",
      "purposes": ["metadata-html"],
      "domains": ["reddit.com"]
    }
  ]
}
```

### `http-connect`

Use this for any provider that exposes a classic HTTP proxy endpoint.

```json
{
  "channels": [
    {
      "name": "residential-http-proxy",
      "type": "http-connect",
      "proxyUrlEnv": "RESIDENTIAL_PROXY_URL",
      "purposes": ["metadata-html"],
      "domains": ["hard-to-fetch.example", "media-site.example"]
    }
  ]
}
```

Or split host/user/pass:

```json
{
  "channels": [
    {
      "name": "residential-http-proxy",
      "type": "http-connect",
      "host": "proxy.example.com",
      "port": 8000,
      "usernameEnv": "PROXY_USERNAME",
      "passwordEnv": "PROXY_PASSWORD",
      "purposes": ["metadata-html"]
    }
  ]
}
```

Limitations:

- Supports `GET` and `HEAD`, which covers current metadata/image fetches.
- Buffers proxied responses up to `maxBodyBytes`; default is `5 MB` for metadata, `12 MB` for OCR images, and `60 MB` for media imports.
- Only `http://` proxy endpoints are supported. HTTPS proxy endpoints need a relay channel.

### `fetch-api`

Use this for unblocker APIs, your own relay worker/container, or providers that expose an HTTP fetch endpoint.

Query parameter mode:

```json
{
  "channels": [
    {
      "name": "query-relay",
      "type": "fetch-api",
      "endpoint": "https://relay.example.com/fetch",
      "targetMode": "query",
      "urlParam": "url",
      "purposes": ["metadata-html"]
    }
  ]
}
```

Header mode:

```json
{
  "channels": [
    {
      "name": "header-relay",
      "type": "fetch-api",
      "endpoint": "https://relay.example.com/fetch",
      "targetMode": "header",
      "targetHeader": "X-Target-Url",
      "authHeader": "Authorization",
      "authTokenEnv": "PROXY_RELAY_TOKEN"
    }
  ]
}
```

JSON body mode:

```json
{
  "channels": [
    {
      "name": "json-relay",
      "type": "fetch-api",
      "endpoint": "https://relay.example.com/fetch",
      "targetMode": "json-body",
      "authHeader": "Authorization",
      "authTokenEnv": "PROXY_RELAY_TOKEN",
      "purposes": ["metadata-html"]
    }
  ]
}
```

The JSON body sent to the relay:

```json
{
  "url": "https://target.example/page",
  "method": "GET",
  "headers": {
    "user-agent": "..."
  }
}
```

Prefix mode:

```json
{
  "channels": [
    {
      "name": "prefix-relay",
      "type": "fetch-api",
      "endpoint": "https://relay.example.com/fetch/",
      "targetMode": "prefix"
    }
  ]
}
```

The worker calls:

```text
https://relay.example.com/fetch/https%3A%2F%2Ftarget.example%2Fpage
```

### `service-binding`

Use this when you own the relay Worker/Container and want Worker-to-Worker routing instead of a public relay URL.

`wrangler.jsonc` example:

```jsonc
{
  "services": [
    {
      "binding": "PROXY_RELAY",
      "service": "metadata-proxy-relay"
    }
  ]
}
```

Channel config:

```json
{
  "channels": [
    {
      "name": "internal-relay",
      "type": "service-binding",
      "binding": "PROXY_RELAY",
      "path": "/fetch",
      "targetMode": "json-body",
      "purposes": ["metadata-html"]
    }
  ]
}
```

The service receives a request like:

```http
POST https://proxy-channel.service/fetch
Content-Type: application/json
```

```json
{
  "url": "https://target.example/page",
  "method": "GET",
  "headers": {
    "user-agent": "..."
  }
}
```

This is the recommended shape for a custom relay that needs SOCKS, browser rendering, provider-specific SDKs, mTLS, or Node proxy agents that are better handled outside the metadata worker.

## API Usage

Normal metadata fetch:

```bash
curl "https://metadata-worker.example.com/?url=https%3A%2F%2Fexample.com%2Fpage"
```

Fresh bulk import:

```bash
curl "https://metadata-worker.example.com/?url=https%3A%2F%2Fone.example&url=https%3A%2F%2Ftwo.example&url=https%3A%2F%2Fthree.example"
```

For larger batches, cached entries return as normal metadata and missing entries return as queued placeholders:

```json
[
  {
    "url": "https://one.example",
    "success": true,
    "metadataQueued": true,
    "isMetadataQueued": true,
    "metadataQueueStatus": "queued",
    "metadataQueueMode": "hydrate",
    "metadataJobId": "job_123",
    "metadataClientKey": "client_abc",
    "metadataSource": "extension",
    "metadataBucket": "one.example",
    "metadataPriority": 5,
    "retryAfterSeconds": 30
  }
]
```

The extension should then poll with `co=1` until the metadata is present. Use the response `Retry-After` header or per-entry `retryAfterSeconds` instead of a fixed polling delay.

Force refresh one or two URLs inline:

```bash
curl "https://metadata-worker.example.com/?url=https%3A%2F%2Fexample.com%2Fpage&re=1"
```

Force refresh larger batches through the queue:

```bash
curl "https://metadata-worker.example.com/?url=https%3A%2F%2Fone.example&url=https%3A%2F%2Ftwo.example&url=https%3A%2F%2Fthree.example&re=1"
```

Read cache only while the queue is working:

```bash
curl "https://metadata-worker.example.com/?url=https%3A%2F%2Fone.example&co=1"
```

Import remote media into R2:

```bash
curl -X POST "https://metadata-worker.example.com/import-media" \
  -H "Content-Type: application/json" \
  -H "X-VS-Import-Token: $IMPORT_MEDIA_TOKEN" \
  --data '{"remoteUrl":"https://example.com/image.jpg","sourcePageUrl":"https://example.com/page"}'
```

Proxy an image for OCR:

```bash
curl "https://metadata-worker.example.com/ocr-image?url=https%3A%2F%2Fexample.com%2Fimage.jpg"
```

## Queue Commands

Create the production queues before deploy:

```bash
npx wrangler queues create metadata-jobs
npx wrangler queues create metadata-jobs-dlq
```

Create dev queues if you deploy `--env dev`:

```bash
npx wrangler queues create metadata-jobs-dev
npx wrangler queues create metadata-jobs-dev-dlq
```

The worker also uses a Durable Object binding named `METADATA_DOMAIN_THROTTLE` to pace queued jobs per domain. The checked-in `wrangler.jsonc` includes the binding and migration.

## Operational Notes

- Keep direct fetch first. Proxies are a fallback, not the normal path.
- Keep DataImpulse or other residential providers scoped by `domains` and `purposes`.
- Keep domain-specific behavior in `METADATA_POLICY_JSON`, not source code.
- Put proxy credentials in secrets, never `wrangler.jsonc`.
- Prefer `metadata-html` first. Image and media proxying can burn bandwidth quickly.
- Order channels cheapest to most expensive. The worker tries them in config order.
- If a channel returns a fallback status, the worker cancels that body and tries the next channel.
- If all proxy channels fail, the worker returns the direct response when one exists; otherwise it returns the original network error.
- Media import is authenticated by default. For local development only, set `ALLOW_UNAUTH_IMPORT_MEDIA=1`; for shared or production deployments, set `IMPORT_MEDIA_TOKEN` as a secret and send `X-VS-Import-Token`.
