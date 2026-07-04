import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('open-graph-scraper', () => ({
	default: async ({ html }: { html: string }) => ({
		error: false,
		result: {
			success: true,
			...extractTestOgMetadata(html),
		},
	}),
}));

import worker from '../src/index';
import { MetadataFetchError } from '../src/metadata-errors';
import { processMetadataQueue, type MetadataQueueMessage } from '../src/metadata-queue';
import { fetchWithProxyFallback } from '../src/outbound-fetch';
import { proxyConnectAuthority } from '../src/http-proxy-tunnel';
import { channelSupportsTarget, parseProxyChannels } from '../src/proxy-channels';
import { resolveMetadataTargetPolicy } from '../src/metadata-policy';
import { buildMetadataHtmlRequestHeaders } from '../src/metadata-request-profile';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function extractTestOgMetadata(html: string): Record<string, string> {
	const metadata: Record<string, string> = {};
	const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
	const ogTitle = readTestMeta(html, 'og:title') || title;
	const ogDescription = readTestMeta(html, 'og:description');
	if (ogTitle) metadata.ogTitle = ogTitle;
	if (ogDescription) metadata.ogDescription = ogDescription;
	return metadata;
}

function readTestMeta(html: string, key: string): string | undefined {
	const pattern = new RegExp(
		`<meta\\s+[^>]*(?:property|name)=["']${escapeRegex(key)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
		'i'
	);
	return pattern.exec(html)?.[1]?.trim();
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createQueueTestEnv(extraEnv: Record<string, unknown> = {}): {
	testEnv: Env;
	sentMessages: Array<MessageSendRequest<unknown>>;
	kvStore: Map<string, string>;
} {
	const kvStore = new Map<string, string>();
	const sentMessages: Array<MessageSendRequest<unknown>> = [];
	const testEnv = {
		...env,
		KV: {
			get: async (key: string) => kvStore.get(key) || null,
			put: async (key: string, value: string) => {
				kvStore.set(key, value);
			},
			delete: async (key: string) => {
				kvStore.delete(key);
			},
		},
		METADATA_QUEUE: {
			sendBatch: async (messages: Array<MessageSendRequest<unknown>>) => {
				sentMessages.push(...messages);
			},
		},
		METADATA_DOMAIN_THROTTLE: undefined,
		...extraEnv,
	} as unknown as Env;
	return { testEnv, sentMessages, kvStore };
}

function createQueueProcessingEnv(extraEnv: Record<string, unknown> = {}) {
	const kvStore = new Map<string, string>();
	const deleteSpy = vi.fn(async (key: string) => {
		kvStore.delete(key);
	});
	const testEnv = {
		...env,
		KV: {
			get: async (key: string) => kvStore.get(key) || null,
			put: async (key: string, value: string) => {
				kvStore.set(key, value);
			},
			delete: deleteSpy,
		},
		METADATA_DOMAIN_THROTTLE: undefined,
		...extraEnv,
	} as unknown as Env;
	return { testEnv, kvStore, deleteSpy };
}

function createMetadataQueueMessage(overrides: Partial<MetadataQueueMessage> = {}): MetadataQueueMessage {
	return {
		version: 1,
		kind: 'metadata',
		mode: 'hydrate',
		url: 'https://queue.example/page',
		baseRequestUrl: 'https://metadata-worker.example.com/?url=https%3A%2F%2Fqueue.example%2Fpage',
		refreshImage: false,
		requestedAt: Date.now(),
		dedupeKey: 'dedupe-test',
		clientKey: 'client-test',
		jobId: 'job-test',
		source: 'extension',
		priority: 5,
		bucket: 'queue.example',
		pollAfterSeconds: 30,
		...overrides,
	};
}

function createQueueBatch(body: unknown) {
	const ack = vi.fn();
	const retry = vi.fn();
	const batch = {
		messages: [
			{
				id: 'message-test',
				body,
				ack,
				retry,
			},
		],
	} as unknown as MessageBatch<MetadataQueueMessage>;
	return { batch, ack, retry };
}

describe('metadata worker', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('returns a helpful error when no url is provided (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Please provide at least one 'url' query parameter." });
	});

	it('includes the target port in HTTPS proxy CONNECT authorities', () => {
		expect(proxyConnectAuthority(new URL('https://www.reddit.com/r/example'))).toBe('www.reddit.com:443');
		expect(proxyConnectAuthority(new URL('https://example.com:8443/page'))).toBe('example.com:8443');
	});

	it('returns a helpful error when no url is provided (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Please provide at least one 'url' query parameter." });
	});

	it('answers OCR image preflight with public CORS headers', async () => {
		const request = new IncomingRequest('http://example.com/ocr-image', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-VS-Client-Key');
		expect(response.headers.get('Access-Control-Allow-Methods')).toContain('HEAD');
	});

	it('serves OCR model routes through opaque asset ids', async () => {
		const request = new IncomingRequest('http://example.com/ocr-model/a3f6c9d1-dec', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('serves a YouTube embed wrapper with referrer policy for extension pages', async () => {
		const request = new IncomingRequest('http://example.com/embed/youtube/SYFMC7CJUtE');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(response.headers.get('Content-Security-Policy')).toContain('frame-src https://www.youtube.com');
		expect(html).toContain('https://www.youtube.com/embed/SYFMC7CJUtE?controls=1&modestbranding=1&playsinline=1&rel=0');
	});

	it('rejects invalid YouTube embed wrapper ids', async () => {
		const request = new IncomingRequest('http://example.com/embed/youtube/not-a-valid-video-id-because-too-long');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Invalid YouTube video id.' });
	});

	it('falls back to YouTube oEmbed metadata when the watch page is blocked', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('https://www.youtube.com/oembed?')) {
				return new Response(
					JSON.stringify({
						title: 'jesus ballin',
						author_name: 'Sanesss',
						type: 'video',
						height: 113,
						width: 200,
						provider_name: 'YouTube',
						thumbnail_height: 360,
						thumbnail_width: 480,
						thumbnail_url: 'https://i.ytimg.com/vi/MAREvZsLpO8/hqdefault.jpg',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			}
			return new Response('blocked by origin', { status: 429, statusText: 'Too Many Requests' });
		});
		vi.stubGlobal('fetch', fetchMock);
		const { testEnv } = createQueueTestEnv();
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DMAREvZsLpO8&re=1'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({
			url: 'https://www.youtube.com/watch?v=MAREvZsLpO8',
			success: true,
			ogSiteName: 'YouTube',
			ogTitle: 'jesus ballin',
			ogDescription: 'By Sanesss on YouTube',
			ogVideoSecureURL: 'https://www.youtube.com/embed/MAREvZsLpO8',
			twitterCard: 'player',
			twitterTitle: 'jesus ballin',
			metadataFetchSource: 'youtube-oembed',
			metadataFetchVia: 'direct',
			isProxyResponse: false,
			metadataHtmlFetchVia: 'direct',
			metadataFallbackReason: 'metadata-html 429 Too Many Requests',
			isCachedResponse: false,
		});
		expect(body[0].error).toBeUndefined();
		expect(body[0].ogImage).toEqual([
			{
				url: 'https://i.ytimg.com/vi/MAREvZsLpO8/hqdefault.jpg',
				width: '480',
				height: '360',
				type: 'jpg',
			},
		]);
		expect(body[0].ogVideo).toEqual([
			{
				url: 'https://www.youtube.com/embed/MAREvZsLpO8',
				type: 'text/html',
				width: '200',
				height: '113',
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('hashes long metadata URLs before using them as cache keys', async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				'<html><head><meta property="og:title" content="Long URL"></head></html>',
				{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { testEnv, kvStore } = createQueueTestEnv();
		const targetUrl = `https://long.example/page?tracking=${'x'.repeat(3_500)}`;
		const request = new IncomingRequest(`http://example.com/?url=${encodeURIComponent(targetUrl)}&re=1`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const metadataCacheKeys = Array.from(kvStore.keys()).filter((key) => key.startsWith('og:v2:'));
		expect(metadataCacheKeys).toHaveLength(1);
		expect(metadataCacheKeys[0]).toMatch(/^og:v2:[a-f0-9]{64}$/);
		expect(metadataCacheKeys[0].length).toBeLessThanOrEqual(512);
	});

	it('accepts oversized metadata URLs through the JSON POST transport', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response('<html><head><meta property="og:title" content="POST metadata"></head></html>', {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				})
			)
		);
		const { testEnv } = createQueueTestEnv();
		const targetUrl = `https://long.example/page?tracking=${'x'.repeat(15_000)}`;
		const request = new IncomingRequest('http://example.com/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ urls: [targetUrl] }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body[0]).toMatchObject({ url: targetUrl, ogTitle: 'POST metadata' });
	});

	it('builds metadata HTML document headers without application-specific Cloudflare headers', () => {
		const headers = buildMetadataHtmlRequestHeaders({
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
			refresh: true,
		});

		expect(headers.get('Accept')).toContain('text/html');
		expect(headers.get('Accept-Language')).toBe('en-US,en;q=0.9');
		expect(headers.get('Sec-Fetch-Mode')).toBe('navigate');
		expect(headers.get('Sec-CH-UA-Platform')).toBe('"macOS"');
		expect(headers.get('Cache-Control')).toBe('no-cache');
		for (const key of headers.keys()) {
			expect(key.startsWith('cf-')).toBe(false);
			expect(key.startsWith('x-vs-')).toBe(false);
		}
	});

	it('uses a Twitterbot user agent for X and Twitter metadata pages', async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				'<html><head><meta property="og:title" content="Tweet metadata"><meta property="og:description" content="Loaded"></head></html>',
				{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { testEnv } = createQueueTestEnv();
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Fx.com%2Fexample%2Fstatus%2F123&re=1'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body[0]).toMatchObject({
			success: true,
			ogTitle: 'Tweet metadata',
			metadataFetchVia: 'direct',
		});
		const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
		expect(headers.get('User-Agent')).toContain('Twitterbot');
	});

	it('retries through proxy when a parsed metadata response matches the challenge policy', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('https://proxy-relay.example/fetch?')) {
				return new Response(
					'<html><head><meta property="og:title" content="Real Reddit post"><meta property="og:description" content="Actual metadata"></head></html>',
					{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
				);
			}
			return new Response('<html><head><title>Reddit - Please wait for verification</title></head></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const { testEnv } = createQueueTestEnv({
			METADATA_POLICY_JSON: JSON.stringify({
				throttle: {
					domains: [
						{
							match: 'reddit.com',
							rejectMetadataTitleIncludes: ['please wait for verification'],
						},
					],
				},
			}),
			PROXY_CHANNELS_JSON: JSON.stringify({
				channels: [
					{
						name: 'relay',
						type: 'fetch-api',
						endpoint: 'https://proxy-relay.example/fetch',
						targetMode: 'query',
						domains: ['reddit.com'],
					},
				],
			}),
		});
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Fwww.reddit.com%2Fr%2Fexample%2Fcomments%2Fabc%2Fpost%2F&re=1'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body[0]).toMatchObject({
			success: true,
			ogTitle: 'Real Reddit post',
			ogDescription: 'Actual metadata',
			metadataFetchVia: 'proxy',
			isProxyResponse: true,
			metadataProxyChannel: 'relay',
			isCachedResponse: false,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0][0])).toBe('https://www.reddit.com/r/example/comments/abc/post/');
		expect(String(fetchMock.mock.calls[1][0])).toBe(
			'https://proxy-relay.example/fetch?url=https%3A%2F%2Fwww.reddit.com%2Fr%2Fexample%2Fcomments%2Fabc%2Fpost%2F'
		);
	});

	it('reports proxy provenance when a required-proxy response is rejected as a challenge', async () => {
		const fetchMock = vi.fn(async () => {
			return new Response('<html><head><title>Reddit - Please wait for verification</title></head></html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const { testEnv } = createQueueTestEnv({
			METADATA_POLICY_JSON: JSON.stringify({
				throttle: {
					domains: [
						{
							match: 'reddit.com',
							proxyMode: 'required',
						},
					],
				},
			}),
			PROXY_CHANNELS_JSON: JSON.stringify({
				channels: [
					{
						name: 'relay',
						type: 'fetch-api',
						endpoint: 'https://proxy-relay.example/fetch',
						targetMode: 'query',
						domains: ['reddit.com'],
					},
				],
			}),
		});
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Fwww.reddit.com%2Fr%2Fexample%2Fcomments%2Fabc%2Fpost%2F&re=1'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body[0]).toMatchObject({
			url: 'https://www.reddit.com/r/example/comments/abc/post/',
			metadataFetchVia: 'proxy',
			isProxyResponse: true,
			metadataProxyChannel: 'relay',
		});
		expect(String(body[0].error)).toContain('Metadata response was rejected by the policy');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			'https://proxy-relay.example/fetch?url=https%3A%2F%2Fwww.reddit.com%2Fr%2Fexample%2Fcomments%2Fabc%2Fpost%2F'
		);
	});

	it('requires explicit opt-in or token for media imports by default', async () => {
		const request = new IncomingRequest('http://example.com/import-media', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ remoteUrl: 'https://asset.example/image.png' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'UNAUTHORIZED_IMPORT_UPLOAD' });
	});

	it('queues large forced metadata refreshes instead of scraping inline', async () => {
		const { testEnv, sentMessages } = createQueueTestEnv();
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Fone.example&url=https%3A%2F%2Ftwo.example&url=https%3A%2F%2Fthree.example&re=1&img=1&client=client-a&job=job-a&src=extension'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(202);
		expect(response.headers.get('X-Metadata-Queued')).toBe('3');
		expect(response.headers.get('X-Metadata-Queue-Mode')).toBe('refresh');
		expect(response.headers.get('X-Metadata-Job-Id')).toBe('job-a');
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(3);
		expect(body.every((entry) => entry.isMetadataQueued === true)).toBe(true);
		expect(body.every((entry) => entry.metadataQueueMode === 'refresh')).toBe(true);
		expect(body.every((entry) => entry.metadataJobId === 'job-a')).toBe(true);
		expect(body.every((entry) => entry.metadataClientKey === 'client-a')).toBe(true);
		expect(body.every((entry) => entry.metadataSource === 'extension')).toBe(true);
		expect(sentMessages).toHaveLength(3);
		expect(sentMessages.every((message) => (message.body as Record<string, unknown>).mode === 'refresh')).toBe(true);
		expect(sentMessages.every((message) => (message.body as Record<string, unknown>).clientKey === 'client-a')).toBe(true);
		expect(sentMessages.every((message) => (message.body as Record<string, unknown>).jobId === 'job-a')).toBe(true);
	});

	it('queues large fresh metadata imports after cache lookup', async () => {
		const { testEnv, sentMessages } = createQueueTestEnv({
			METADATA_POLICY_JSON: JSON.stringify({
				defaultPollAfterSeconds: 11,
				throttle: {
					domains: [
						{
							match: 'fresh-one.example',
							bucket: 'fresh-bucket',
							pollAfterSeconds: 17,
							priority: 9,
						},
					],
				},
			}),
		});
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Ffresh-one.example&url=https%3A%2F%2Ffresh-two.example&url=https%3A%2F%2Ffresh-three.example'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(202);
		expect(response.headers.get('X-Metadata-Queued')).toBe('3');
		expect(response.headers.get('X-Metadata-Queue-Mode')).toBe('hydrate');
		expect(response.headers.get('Retry-After')).toBe('17');
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(3);
		expect(body.every((entry) => entry.isMetadataQueued === true)).toBe(true);
		expect(body.every((entry) => entry.metadataQueueMode === 'hydrate')).toBe(true);
		expect(body[0].metadataBucket).toBe('fresh-bucket');
		expect(body[0].metadataPriority).toBe(9);
		expect(body[0].retryAfterSeconds).toBe(17);
		expect(sentMessages).toHaveLength(3);
		expect(sentMessages.every((message) => (message.body as Record<string, unknown>).mode === 'hydrate')).toBe(true);
		expect((sentMessages[0].body as Record<string, unknown>).bucket).toBe('fresh-bucket');
		expect((sentMessages[0].body as Record<string, unknown>).priority).toBe(9);
	});

	it('answers cache-only polls with pending placeholders without enqueueing duplicate work', async () => {
		const { testEnv, sentMessages } = createQueueTestEnv({
			METADATA_POLICY_JSON: JSON.stringify({
				defaultPollAfterSeconds: 13,
				throttle: {
					domains: [
						{
							match: 'pending.example',
							bucket: 'pending-bucket',
							pollAfterSeconds: 19,
						},
					],
				},
			}),
		});
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Fpending.example%2Fpage&co=1&client=client-poll&job=job-poll&src=extension'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(202);
		expect(response.headers.get('Retry-After')).toBe('19');
		expect(sentMessages).toHaveLength(0);
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({
			url: 'https://pending.example/page',
			isMetadataQueued: true,
			metadataQueueStatus: 'pending',
			metadataQueueMode: 'hydrate',
			metadataJobId: 'job-poll',
			metadataClientKey: 'client-poll',
			metadataSource: 'extension',
			metadataBucket: 'pending-bucket',
			retryAfterSeconds: 19,
		});
	});

	it('rejects oversized metadata requests instead of silently dropping URLs', async () => {
		const { testEnv } = createQueueTestEnv({
			METADATA_POLICY_JSON: JSON.stringify({ maxUrlsPerRequest: 2 }),
		});
		const request = new IncomingRequest(
			'http://example.com/?url=https%3A%2F%2Fone.example&url=https%3A%2F%2Ftwo.example&url=https%3A%2F%2Fthree.example'
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'Too many URLs in one metadata request.',
			maxUrlsPerRequest: 2,
			receivedUrls: 3,
		});
	});

	it('resolves domain buckets and throttle rules from policy config', () => {
		const testEnv = {
			...env,
			METADATA_POLICY_JSON: JSON.stringify({
				defaultPollAfterSeconds: 12,
				throttle: {
					default: { intervalMs: 250, maxConcurrent: 3 },
					domains: [
						{
							match: ['example.com', '*.example.org'],
							bucket: 'example-family',
							throttle: { intervalMs: 900, maxConcurrent: 1 },
							pollAfterSeconds: 22,
							priority: 7,
						},
					],
				},
			}),
		} as unknown as Env;

		const resolved = resolveMetadataTargetPolicy(testEnv, 'https://www.example.com/page', 'hydrate');

		expect(resolved.bucket).toBe('example-family');
		expect(resolved.throttle.intervalMs).toBe(900);
		expect(resolved.throttle.maxConcurrent).toBe(1);
		expect(resolved.pollAfterSeconds).toBe(22);
		expect(resolved.priority).toBe(7);
	});

	it('requires a proxy only when the matching domain policy opts in', () => {
		const testEnv = {
			...env,
			METADATA_POLICY_JSON: JSON.stringify({
				throttle: {
					domains: [
						{
							match: 'reddit.com',
							proxyMode: 'required',
							rejectMetadataTitleIncludes: ['Please wait for verification'],
						},
					],
				},
			}),
		} as unknown as Env;

		expect(resolveMetadataTargetPolicy(testEnv, 'https://www.reddit.com/r/example', 'hydrate').proxyMode).toBe(
			'required'
		);
		expect(
			resolveMetadataTargetPolicy(testEnv, 'https://www.reddit.com/r/example', 'hydrate').rejectMetadataTitleIncludes
		).toEqual(['please wait for verification']);
		expect(resolveMetadataTargetPolicy(testEnv, 'https://example.com/page', 'hydrate').proxyMode).toBe('fallback');
	});

	it('leases queued work with the per-domain throttle durable object', async () => {
		const throttle = env.METADATA_DOMAIN_THROTTLE;
		expect(throttle).toBeTruthy();
		const stub = throttle?.get(throttle.idFromName('unit-test-bucket'));
		const rule = {
			intervalMs: 500,
			maxConcurrent: 1,
			leaseTtlMs: 1000,
			maxDelayMs: 5000,
		};

		const first = await stub?.acquire('unit-test-bucket', rule);
		const second = await stub?.acquire('unit-test-bucket', rule);

		expect(first?.granted).toBe(true);
		expect(first?.delayMs).toBe(0);
		expect(first?.leaseId).toBeTruthy();
		expect(second?.granted).toBe(false);
		expect(second?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		await stub?.release(first?.leaseId || '');
		const third = await stub?.acquire('unit-test-bucket', rule);
		expect(third?.granted).toBe(true);
		await stub?.release(third?.leaseId || '');
	});

	it('retries queue messages without processing when a domain bucket is saturated', async () => {
		const acquire = vi.fn(async () => ({
			bucket: 'queue.example',
			granted: false,
			delayMs: 7000,
			retryAfterSeconds: 7,
			intervalMs: 1000,
			maxConcurrent: 1,
			activeCount: 1,
		}));
		const release = vi.fn();
		const idFromName = vi.fn(() => 'queue-example-id');
		const get = vi.fn(() => ({ acquire, release }));
		const { testEnv } = createQueueProcessingEnv({
			METADATA_DOMAIN_THROTTLE: { idFromName, get },
		});
		const { batch, ack, retry } = createQueueBatch(createMetadataQueueMessage());
		const processMetadata = vi.fn();

		await processMetadataQueue(batch, testEnv, processMetadata);

		expect(processMetadata).not.toHaveBeenCalled();
		expect(ack).not.toHaveBeenCalled();
		expect(retry).toHaveBeenCalledWith({ delaySeconds: 7 });
		expect(release).not.toHaveBeenCalled();
	});

	it('releases the domain lease and retries when metadata processing is retryable', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const acquire = vi.fn(async () => ({
			bucket: 'queue.example',
			granted: true,
			leaseId: 'lease-retry',
			delayMs: 0,
			retryAfterSeconds: 1,
			intervalMs: 100,
			maxConcurrent: 2,
			activeCount: 1,
		}));
		const release = vi.fn();
		const idFromName = vi.fn(() => 'queue-example-id');
		const get = vi.fn(() => ({ acquire, release }));
		const { testEnv, deleteSpy } = createQueueProcessingEnv({
			METADATA_DOMAIN_THROTTLE: { idFromName, get },
		});
		const { batch, ack, retry } = createQueueBatch(createMetadataQueueMessage());
		const processMetadata = vi.fn(async () => {
			throw new MetadataFetchError('Origin asked us to slow down.', {
				retryable: true,
				retryAfterSeconds: 42,
			});
		});

		await processMetadataQueue(batch, testEnv, processMetadata);

		expect(processMetadata).toHaveBeenCalledTimes(1);
		expect(retry).toHaveBeenCalledWith({ delaySeconds: 42 });
		expect(ack).not.toHaveBeenCalled();
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledWith('lease-retry');
	});

	it('unlocks and acks queue messages after permanent metadata failures', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const acquire = vi.fn(async () => ({
			bucket: 'queue.example',
			granted: true,
			leaseId: 'lease-permanent',
			delayMs: 0,
			retryAfterSeconds: 1,
			intervalMs: 100,
			maxConcurrent: 2,
			activeCount: 1,
		}));
		const release = vi.fn();
		const idFromName = vi.fn(() => 'queue-example-id');
		const get = vi.fn(() => ({ acquire, release }));
		const { testEnv, deleteSpy } = createQueueProcessingEnv({
			METADATA_DOMAIN_THROTTLE: { idFromName, get },
		});
		const { batch, ack, retry } = createQueueBatch(createMetadataQueueMessage());
		const processMetadata = vi.fn(async () => {
			throw new Error('Permanent parser failure.');
		});

		await processMetadataQueue(batch, testEnv, processMetadata);

		expect(processMetadata).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledTimes(1);
		expect(deleteSpy).toHaveBeenCalledWith('q:lock:dedupe-test');
		expect(release).toHaveBeenCalledWith('lease-permanent');
	});

	it('acks invalid queue messages so malformed payloads cannot spin forever', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { testEnv } = createQueueProcessingEnv();
		const { batch, ack, retry } = createQueueBatch({ kind: 'metadata', url: 'https://bad.example' });
		const processMetadata = vi.fn();

		await processMetadataQueue(batch, testEnv, processMetadata);

		expect(processMetadata).not.toHaveBeenCalled();
		expect(retry).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledTimes(1);
	});

	it('normalizes DataImpulse as an opt-in HTTP CONNECT channel', () => {
		const testEnv = {
			...env,
			PROXY_CHANNELS_JSON: JSON.stringify({
				channels: [
					{
						name: 'dataimpulse-residential',
						type: 'dataimpulse',
						purposes: ['metadata-html'],
						domains: ['x.com', 'youtube.com'],
					},
				],
			}),
			DATAIMPULSE_USERNAME: 'proxy-user',
			DATAIMPULSE_PASSWORD: 'proxy-pass',
		} as unknown as Env;

		const channels = parseProxyChannels(testEnv);

		expect(channels).toHaveLength(1);
		expect(channels[0].type).toBe('http-connect');
		expect(channels[0].name).toBe('dataimpulse-residential');
		expect(channelSupportsTarget(channels[0], 'https://x.com/home', 'metadata-html')).toBe(true);
		expect(channelSupportsTarget(channels[0], 'https://example.com', 'metadata-html')).toBe(false);
		expect(channelSupportsTarget(channels[0], 'https://x.com/home', 'media-import')).toBe(false);
		if (channels[0].type === 'http-connect') {
			expect(channels[0].proxy.hostname).toBe('gw.dataimpulse.com');
			expect(channels[0].proxy.port).toBe(823);
			expect(channels[0].proxy.username).toBe('proxy-user');
			expect(channels[0].proxy.password).toBe('proxy-pass');
		}
	});

	it('normalizes a SOCKS5 channel with secret-backed credentials', () => {
		const testEnv = {
			...env,
			PROXY_CHANNELS_JSON: JSON.stringify({
				channels: [
					{
						name: 'residential-socks',
						type: 'socks5',
						host: 'gw.example.test',
						port: 824,
						usernameEnv: 'PROXY_USERNAME',
						passwordEnv: 'PROXY_PASSWORD',
					},
				],
			}),
			PROXY_USERNAME: 'proxy-user',
			PROXY_PASSWORD: 'proxy-pass',
		} as unknown as Env;

		const channels = parseProxyChannels(testEnv);

		expect(channels).toHaveLength(1);
		expect(channels[0]).toMatchObject({
			name: 'residential-socks',
			type: 'socks5',
			proxyUrl: 'socks5://proxy-user:proxy-pass@gw.example.test:824',
		});
	});

	it('works without proxy channels and returns the direct response', async () => {
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await fetchWithProxyFallback(env, 'https://example.com/page', {}, { purpose: 'metadata-html' });

		expect(result.via).toBe('direct');
		expect(result.channel).toBeUndefined();
		expect(result.response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('falls back to a generic fetch API channel after a retryable direct response', async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ input, init });
			if (calls.length === 1) {
				return new Response('rate limited', { status: 429 });
			}
			return new Response('<html><title>ok</title></html>', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const testEnv = {
			...env,
			PROXY_CHANNELS_JSON: JSON.stringify({
				channels: [
					{
						name: 'relay',
						type: 'fetch-api',
						endpoint: 'https://proxy-relay.example/fetch',
						targetMode: 'json-body',
						authHeader: 'Authorization',
						authTokenEnv: 'PROXY_RELAY_TOKEN',
					},
				],
			}),
			PROXY_RELAY_TOKEN: 'Bearer test-token',
		} as unknown as Env;

		const result = await fetchWithProxyFallback(
			testEnv,
			'https://blocked.example/page',
			{ headers: { 'User-Agent': 'VibeSearchBot/1.0' } },
			{ purpose: 'metadata-html' }
		);

		expect(result.via).toBe('proxy');
		expect(result.channel).toBe('relay');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(calls[1].input)).toBe('https://proxy-relay.example/fetch');
		const headers = new Headers(calls[1].init?.headers);
		expect(headers.get('Authorization')).toBe('Bearer test-token');
		expect(headers.get('Content-Type')).toBe('application/json');
		const body = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
		expect(body.url).toBe('https://blocked.example/page');
		expect(body.method).toBe('GET');
		expect(body.headers).toEqual({ 'user-agent': 'VibeSearchBot/1.0' });
	});

	it('does not use direct egress when a proxy is required', async () => {
		const fetchMock = vi.fn(async () => new Response('from proxy', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const testEnv = {
			...env,
			PROXY_CHANNELS_JSON: JSON.stringify({
				channels: [
					{
						name: 'residential',
						type: 'fetch-api',
						endpoint: 'https://proxy-relay.example/fetch',
						targetMode: 'query',
						domains: ['reddit.com'],
					},
				],
			}),
		} as unknown as Env;

		const result = await fetchWithProxyFallback(
			testEnv,
			'https://www.reddit.com/r/example/comments/123/post/',
			{},
			{ purpose: 'metadata-html', forceProxy: true }
		);

		expect(result.via).toBe('proxy');
		expect(result.channel).toBe('residential');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			'https://proxy-relay.example/fetch?url=https%3A%2F%2Fwww.reddit.com%2Fr%2Fexample%2Fcomments%2F123%2Fpost%2F'
		);
	});

	it('can route fallback through a Cloudflare service binding channel', async () => {
		const directFetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }));
		const serviceFetchMock = vi.fn(async () => new Response('from service', { status: 200 }));
		vi.stubGlobal('fetch', directFetchMock);
		const testEnv = {
			...env,
			PROXY_CHANNELS_JSON: JSON.stringify({
				channels: [
					{
						name: 'internal-relay',
						type: 'service-binding',
						binding: 'PROXY_RELAY',
						path: '/fetch',
						targetMode: 'json-body',
					},
				],
			}),
			PROXY_RELAY: {
				fetch: serviceFetchMock,
			},
		} as unknown as Env;

		const result = await fetchWithProxyFallback(
			testEnv,
			'https://blocked.example/page',
			{ headers: { Accept: 'text/html' } },
			{ purpose: 'metadata-html' }
		);

		expect(result.via).toBe('proxy');
		expect(result.channel).toBe('internal-relay');
		expect(directFetchMock).toHaveBeenCalledTimes(1);
		expect(serviceFetchMock).toHaveBeenCalledTimes(1);
		const serviceRequest = serviceFetchMock.mock.calls[0][0] as Request;
		expect(serviceRequest.url).toBe('https://proxy-channel.service/fetch');
		expect(serviceRequest.method).toBe('POST');
		expect(serviceRequest.headers.get('Content-Type')).toBe('application/json');
		const body = (await serviceRequest.json()) as Record<string, unknown>;
		expect(body.url).toBe('https://blocked.example/page');
		expect(body.headers).toEqual({ accept: 'text/html' });
	});
});
