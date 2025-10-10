import ogs from 'open-graph-scraper';
import { userAgents } from './user-agents';

let userAgentIndex = 0;

const twitterUserAgents = userAgents.filter((ua) => ua.toLowerCase().includes('twitterbot'));

function isTwitterHost(hostname: string): boolean {
	hostname = hostname.toLowerCase();
	return hostname === 'twitter.com' || hostname.endsWith('.twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com');
}

function isInstagramHost(hostname: string): boolean {
	hostname = hostname.toLowerCase();
	return hostname === 'instagram.com' || hostname.endsWith('.instagram.com');
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

function normalizePublicBase(value: string | undefined): string | undefined {
	if (!value || value.length === 0) return undefined;
	if (value.startsWith('http://') || value.startsWith('https://')) return value.replace(/\/$/, '');
	return `https://${value.replace(/\/$/, '')}`;
}

async function ensureR2Image(env: Env, key: string, imageUrl: string): Promise<boolean> {
	const r2 = (env as unknown as { R2?: R2Bucket }).R2;
	if (!r2) return false;
	const head = await r2.head(key);
	if (head) return true;
	const res = await fetch(imageUrl);
	if (!res.ok) return false;
	const contentType = res.headers.get('content-type') || 'application/octet-stream';
	await r2.put(key, res.body || (await res.arrayBuffer()), { httpMetadata: { contentType } });
	return true;
}

async function rewriteInstagramImagesToR2(
	env: Env,
	ctx: ExecutionContext,
	resultObj: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const publicBase = normalizePublicBase((env as unknown as { R2_PUBLIC_BASE?: string }).R2_PUBLIC_BASE);
	const processField = async (field: 'ogImage' | 'twitterImage') => {
		const arr = resultObj[field] as unknown;
		if (!Array.isArray(arr)) return;
		const newArr = await Promise.all(
			arr.map(async (item: unknown) => {
				const obj = (item as Record<string, unknown>) || {};
				const urlVal = obj['url'];
				if (typeof urlVal !== 'string' || urlVal.length === 0) return obj;
				const key = `igimg/${encodeURIComponent(urlVal)}`;
				// Ensure present in R2 before rewriting to avoid 404s
				if (publicBase && (await ensureR2Image(env, key, urlVal))) {
					return { ...obj, url: `${publicBase}/${key}` };
				}
				return obj;
			})
		);
		(resultObj as Record<string, unknown>)[field] = newArr as unknown as Record<string, unknown>;
	};
	await processField('ogImage');
	await processField('twitterImage');
	return resultObj;
}

async function getOgDataForUrl(
	env: Env,
	ctx: ExecutionContext,
	baseRequestUrl: string,
	targetUrl: string,
	refresh: boolean
): Promise<Record<string, unknown>> {
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
	let resultObj = { ...(result as Record<string, unknown>) } as Record<string, unknown>;

	// For Instagram: store images in R2 and rewrite image URLs to R2 (no 404s)
	try {
		const hostname = new URL(targetUrl).hostname;
		if (isInstagramHost(hostname)) {
			resultObj = await rewriteInstagramImagesToR2(env, ctx, resultObj);
		}
	} catch (_) {
		// best-effort only
	}

	const data = { url: targetUrl, ...resultObj } as Record<string, unknown>;

	const headers = new Headers({
		'Content-Type': 'application/json',
		'Cache-Control': CACHE_CONTROL_VALUE,
	});
	// Also write under canonical keys if Instagram ogUrl is present
	const writes: Promise<unknown>[] = [
		cache.put(cacheKey, new Response(JSON.stringify(data), { headers })),
		env.KV.put(kvKey, JSON.stringify(data), { expirationTtl: TEN_DAYS_SECONDS }),
	];
	const canonicalUrl = (data as Record<string, unknown>)['canonicalUrl'];
	if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
		const canonicalCacheKey = buildPerUrlCacheKey(baseRequestUrl, canonicalUrl);
		const canonicalKvKey = buildKvKey(canonicalUrl);
		writes.push(cache.put(canonicalCacheKey, new Response(JSON.stringify(data), { headers })));
		writes.push(env.KV.put(canonicalKvKey, JSON.stringify(data), { expirationTtl: TEN_DAYS_SECONDS }));
	}
	ctx.waitUntil(Promise.all(writes));

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
