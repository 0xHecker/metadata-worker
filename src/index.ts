import ogs from 'open-graph-scraper';
import { userAgents } from "./user-agents";

let userAgentIndex = 0;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { searchParams } = new URL(request.url);
		const urlsToScrapeQuery = searchParams.get('url');

		if (!urlsToScrapeQuery) {
			return new Response(JSON.stringify({ error: "Please provide a 'url' query parameter." }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Edge cache: 1-week TTL keyed by full request URL
		let cacheKey: Request | undefined;
		if (request.method === 'GET') {
			cacheKey = new Request(request.url, request);
			const cached = await caches.default.match(cacheKey);
			if (cached) {
				return cached;
			}
		}

		const urls = urlsToScrapeQuery.split(',').slice(0, 10);

		try {
			const results = await Promise.all(
				urls.map(async (url) => {
					const currentUserAgent = userAgents[userAgentIndex];
					userAgentIndex = (userAgentIndex + 1) % userAgents.length;

					const response = await fetch(url, {
						headers: {
							'User-Agent': currentUserAgent,
						},
					});

					const html = await response.text();
					const { result } = await ogs({ html });
					return { url, ...result };
				})
			);

			const res = new Response(JSON.stringify(results), {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'public, max-age=604800'
				},
			});
			if (cacheKey) {
				ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
			}
			return res;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},
};
