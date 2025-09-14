import ogs from 'open-graph-scraper';
import { userAgents } from "./user-agents";

let userAgentIndex = 0;

const twitterUserAgents = userAgents.filter((ua) => ua.toLowerCase().includes('twitterbot'));

function isTwitterHost(hostname: string): boolean {
	hostname = hostname.toLowerCase();
	return hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com');
}

function selectUserAgent(targetUrl: string): string {
	try {
		const hostname = new URL(targetUrl).hostname;
		if (isTwitterHost(hostname)) {
			if (twitterUserAgents.length > 0) {
				const randomIndex = Math.floor(Math.random() * twitterUserAgents.length);
				return twitterUserAgents[randomIndex];
			}
			return 'Twitterbot/1.0';
		}
	} catch (_) {
		// Fallback to rotation for malformed URLs
	}
	const ua = userAgents[userAgentIndex];
	userAgentIndex = (userAgentIndex + 1) % userAgents.length;
	return ua;
}

const TEN_DAYS_SECONDS = 864000;
const CACHE_CONTROL_VALUE = `public, s-maxage=${TEN_DAYS_SECONDS}, max-age=${TEN_DAYS_SECONDS}`;
const KV_PREFIX = 'og:v1:';

function buildPerUrlCacheKey(baseRequestUrl: string, targetUrl: string): Request {
	const keyUrl = new URL(`/__og-cache?u=${encodeURIComponent(targetUrl)}`, baseRequestUrl);
	return new Request(keyUrl.toString());
}

function buildKvKey(targetUrl: string): string {
	return `${KV_PREFIX}${targetUrl}`;
}

async function getOgDataForUrl(env: Env, ctx: ExecutionContext, baseRequestUrl: string, targetUrl: string, refresh: boolean): Promise<Record<string, unknown>> {
	const cache = caches.default;
	const cacheKey = buildPerUrlCacheKey(baseRequestUrl, targetUrl);
	const kvKey = buildKvKey(targetUrl);

	if (!refresh) {
		const cached = await cache.match(cacheKey);
		if (cached) {
			const data = (await cached.json()) as Record<string, unknown>;
			return { ...data, isCachedResponse: true } as Record<string, unknown>;
		}

		// Try KV global cache next
		const kvValue = await env.KV.get(kvKey);
		if (kvValue) {
			try {
				const data = JSON.parse(kvValue) as Record<string, unknown>;
				const headers = new Headers({
					'Content-Type': 'application/json',
					'Cache-Control': CACHE_CONTROL_VALUE,
				});
				ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), { headers })));
				return { ...data, isCachedResponse: true } as Record<string, unknown>;
			} catch (_) {
				// Corrupt KV entry, treat as miss
			}
		}
	}

	const userAgent = selectUserAgent(targetUrl);
	const response = await fetch(targetUrl, {
		headers: {
			'User-Agent': userAgent,
		},
	});
	const html = await response.text();
	const { result } = await ogs({ html });
	const data = { url: targetUrl, ...result } as Record<string, unknown>;

	const headers = new Headers({
		'Content-Type': 'application/json',
		'Cache-Control': CACHE_CONTROL_VALUE,
	});
	ctx.waitUntil(
		Promise.all([
			cache.put(cacheKey, new Response(JSON.stringify(data), { headers })),
			env.KV.put(kvKey, JSON.stringify(data), { expirationTtl: TEN_DAYS_SECONDS }),
		])
	);

	return { ...data, isCachedResponse: false } as Record<string, unknown>;
}

async function buildResponse(env: Env, ctx: ExecutionContext, urls: string[], baseRequestUrl: string, refresh: boolean): Promise<Response> {
	const results = await Promise.all(urls.map((u) => getOgDataForUrl(env, ctx, baseRequestUrl, u, refresh)));
	return new Response(JSON.stringify(results), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': CACHE_CONTROL_VALUE,
		},
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const urlsToScrapeQuery = url.searchParams.get('url');

		if (!urlsToScrapeQuery) {
			return new Response(JSON.stringify({ error: "Please provide a 'url' query parameter." }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const urls = urlsToScrapeQuery.split(',').slice(0, 10);

		try {
			const refresh = url.searchParams.has('re') && request.method === 'GET';
			const response = await buildResponse(env, ctx, urls, request.url, refresh);
			return response;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},
};
