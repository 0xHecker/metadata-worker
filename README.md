# Metadata Worker

Cloudflare Worker for fetching, caching, refreshing, and serving metadata/media helpers for VibeSearch.

Key docs:

- [Proxy channels](docs/proxy-channels.md): direct fetch, DataImpulse, generic HTTP CONNECT proxies, relay APIs, queue usage, and API examples.
- [Metadata API architecture](docs/metadata-api-architecture.md): request stories, Mermaid diagrams, dry-run scenarios, and debugging map.

Common checks:

```bash
npx tsc --noEmit
npm test
```
