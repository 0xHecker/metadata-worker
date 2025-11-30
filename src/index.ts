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
	// Use fixed base for cache key consistency if needed, but here we follow the request
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

async function sha256(str: string): Promise<string> {
	const te = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', te.encode(str));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureR2Image(
	env: Env,
	key: string,
	imageUrl: string,
	userAgent: string,
	referer: string,
	refreshImage: boolean
): Promise<boolean> {
	const r2 = env.R2;
	if (!r2) return false;

	if (!refreshImage) {
		const head = await r2.head(key);
		if (head) return true;
	}
	console.log(`Downloading image from: ${imageUrl}`);
	try {
		const res = await fetch(imageUrl, {
			headers: {
				'User-Agent': userAgent,
				Referer: referer,
				Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9',
				'Accept-Encoding': 'gzip, deflate, br',
				Connection: 'keep-alive',
				'Upgrade-Insecure-Requests': '1',
				'Sec-Fetch-Dest': 'document',
				'Sec-Fetch-Mode': 'navigate',
				'Sec-Fetch-Site': 'cross-site',
				'Sec-Fetch-User': '?1',
			},
			signal: AbortSignal.timeout(10000), // 10s timeout
		});
		if (!res.ok) {
			console.error(`Failed to fetch image from ${imageUrl}. Status: ${res.status} ${res.statusText}`);
			return false;
		}

		// Use streaming upload to avoid loading entire image into memory
		const contentType = res.headers.get('content-type') || 'application/octet-stream';
		console.log(`Uploading to R2 with content-type: ${contentType}`);

		await r2.put(key, res.body, {
			httpMetadata: { contentType },
		});
		return true;
	} catch (e) {
		console.error(`Failed to upload to R2 for key ${key}: ${(e as Error).message}`);
		return false;
	}
}

async function rewriteInstagramImagesToR2(
	env: Env,
	ctx: ExecutionContext,
	resultObj: Record<string, unknown>,
	originalUserAgent: string,
	refererUrl: string,
	refreshImage: boolean
): Promise<Record<string, unknown>> {
	const publicBase = normalizePublicBase(env.R2_PUBLIC_BASE);
	const processField = async (field: 'ogImage' | 'twitterImage') => {
		const arr = resultObj[field] as unknown;
		if (!Array.isArray(arr)) return;
		const newArr = await Promise.all(
			arr.map(async (item: unknown) => {
				const obj = (item as Record<string, unknown>) || {};
				const urlVal = obj['url'];
				if (typeof urlVal !== 'string' || urlVal.length === 0) return obj;
				console.log(`Original Instagram OG Image URL: ${urlVal}`);
				const key = `igimg/${await sha256(urlVal)}.jpg`;
				if (publicBase && (await ensureR2Image(env, key, urlVal, originalUserAgent, refererUrl, refreshImage))) {
					const r2Url = `${publicBase}/${key}`;
					console.log(`Rewriting to R2 URL: ${r2Url}`);
					return { ...obj, url: r2Url };
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
	refresh: boolean,
	refreshImage: boolean
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
		signal: AbortSignal.timeout(10000),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch ${targetUrl}: ${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	const { result, error } = await ogs({ html });

	if (error) {
		console.warn(`OGS reported error for ${targetUrl}:`, result);
	}

	let resultObj = { ...(result as Record<string, unknown>) } as Record<string, unknown>;

	// For Instagram: store images in R2 and rewrite image URLs to R2 (no 404s)
	try {
		const hostname = new URL(targetUrl).hostname;
		if (isInstagramHost(hostname)) {
			resultObj = await rewriteInstagramImagesToR2(env, ctx, resultObj, userAgent, targetUrl, refreshImage);
		}
	} catch (e) {
		console.error(`Instagram rewrite failed for ${targetUrl}:`, e);
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
		try {
			const canonicalCacheKey = buildPerUrlCacheKey(baseRequestUrl, canonicalUrl);
			const canonicalKvKey = buildKvKey(canonicalUrl);
			writes.push(cache.put(canonicalCacheKey, new Response(JSON.stringify(data), { headers })));
			writes.push(env.KV.put(canonicalKvKey, JSON.stringify(data), { expirationTtl: TEN_DAYS_SECONDS }));
		} catch (e) {
			console.warn('Failed to build/write canonical cache key:', e);
		}
	}
	ctx.waitUntil(Promise.all(writes));

	return { ...data, isCachedResponse: false } as Record<string, unknown>;
}

async function buildResponse(
	env: Env,
	ctx: ExecutionContext,
	urls: string[],
	baseRequestUrl: string,
	refresh: boolean,
	refreshImage: boolean
): Promise<Response> {
	const results = await Promise.all(
		urls.map(async (u) => {
			try {
				return await getOgDataForUrl(env, ctx, baseRequestUrl, u, refresh, refreshImage);
			} catch (error) {
				return { url: u, error: error instanceof Error ? error.message : String(error) };
			}
		})
	);
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
		const urlsToScrape = url.searchParams.getAll('url');

		if (urlsToScrape.length === 0) {
			return new Response(JSON.stringify({ error: "Please provide at least one 'url' query parameter." }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const urls = urlsToScrape.slice(0, 10).map((u) => u.trim().replace(/^https?:\/\/https?:\/\//, 'https://'));

		try {
			const refresh = url.searchParams.has('re') && request.method === 'GET';
			const refreshImage = url.searchParams.get('img') === '1' && request.method === 'GET';
			const response = await buildResponse(env, ctx, urls, request.url, refresh, refreshImage);
			return response;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(errorMessage);
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},
};
