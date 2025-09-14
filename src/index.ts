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

async function buildResponse(urls: string[]): Promise<Response> {
	const results = await Promise.all(
		urls.map(async (url) => {
			const userAgent = selectUserAgent(url);
			const response = await fetch(url, {
				headers: {
					'User-Agent': userAgent,
				},
			});
			const html = await response.text();
			const { result } = await ogs({ html });
			return { url, ...result };
		})
	);

	return new Response(JSON.stringify(results), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': CACHE_CONTROL_VALUE,
		},
	});
}

async function cachePut(request: Request, response: Response): Promise<void> {
	const cache = caches.default;
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', CACHE_CONTROL_VALUE);
	const cachedResponse = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
	await cache.put(request, cachedResponse);
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
			// 1) Cache bust via ?re=1 (GET only)
			if (url.searchParams.has('re') && request.method === 'GET') {
				const freshResponse = await buildResponse(urls);
				ctx.waitUntil(cachePut(request, freshResponse.clone()));
				return freshResponse;
			}

			// 2) Try Cloudflare cache first (GET only)
			if (request.method === 'GET') {
				const cached = await caches.default.match(request);
				if (cached) {
					return cached;
				}
			}

			// 3) No cache hit: compute and cache (GET only)
			const originResponse = await buildResponse(urls);
			if (request.method === 'GET') {
				ctx.waitUntil(cachePut(request, originResponse.clone()));
			}
			return originResponse;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},
};
