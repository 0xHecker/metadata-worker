import { twitterUserAgents, userAgents } from './user-agents';
import { fetchWithProxyFallback, isRetryableHttpStatus, parseRetryAfterSeconds } from './outbound-fetch';
import { OCR_MODEL_RATE_LIMIT, handleOcrModel, resolveOcrModelId } from './ocr-models';
import {
	enqueueMetadataJobs,
	processMetadataQueue,
	type MetadataQueueMessage,
} from './metadata-queue';
import { getMetadataPolicy, resolveMetadataTargetPolicy, type MetadataQueueMode } from './metadata-policy';
import { MetadataFetchError } from './metadata-errors';
import { getClientIp, getMetadataRequestContext, type MetadataRequestContext } from './metadata-request-context';
import { buildMetadataHtmlRequestHeaders } from './metadata-request-profile';

export { MetadataDomainThrottle } from './metadata-domain-throttle';

let userAgentIndex = 0;
let twitterUserAgentIndex = 0;
type OpenGraphScraper = (options: { html: string }) => Promise<{ result: unknown; error?: boolean }>;

let ogsPromise: Promise<OpenGraphScraper> | null = null;

function getOpenGraphScraper(): Promise<OpenGraphScraper> {
	if (!ogsPromise) {
		ogsPromise = import('open-graph-scraper').then((mod) => {
			const loaded = mod as unknown as { default?: unknown };
			return (typeof loaded.default === 'function' ? loaded.default : mod) as OpenGraphScraper;
		});
	}
	return ogsPromise;
}

function selectUserAgent(env: Env, targetUrl: string): string {
	const configuredUserAgent = resolveMetadataTargetPolicy(env, targetUrl, 'hydrate').userAgent;
	if (configuredUserAgent) return configuredUserAgent;
	if (isTwitterMetadataUrl(targetUrl)) {
		const ua = twitterUserAgents[twitterUserAgentIndex];
		twitterUserAgentIndex = (twitterUserAgentIndex + 1) % twitterUserAgents.length;
		return ua;
	}
	const ua = userAgents[userAgentIndex];
	userAgentIndex = (userAgentIndex + 1) % userAgents.length;
	return ua;
}

function isTwitterMetadataUrl(value: string): boolean {
	try {
		const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
		return hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com');
	} catch {
		return false;
	}
}

const TEN_DAYS_SECONDS = 864000;
const CACHE_CONTROL_VALUE = `public, s-maxage=${TEN_DAYS_SECONDS}, max-age=${TEN_DAYS_SECONDS}`;
const KV_PREFIX = 'og:v2:';
const OG_CACHE_PATH = '/__og-cache-v2';
const IMPORT_MEDIA_UPLOAD_PATH = '/import-media';
const R2_OBJECT_PATH_PREFIX = '/r2/';
const OCR_IMAGE_PROXY_PATH = '/ocr-image';
const YOUTUBE_EMBED_PATH_PREFIX = '/embed/youtube/';
const IMPORT_MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const OCR_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const IMPORT_TOKEN_HEADER = 'X-VS-Import-Token';
const R2_OBJECT_RATE_LIMIT = { windowSeconds: 60, maxRequests: 300 };
const OCR_IMAGE_RATE_LIMIT = { windowSeconds: 60, maxRequests: 120 };
const YOUTUBE_METADATA_FALLBACK_STATUSES = [400, 403, 407, 408, 409, 425, 429, 451, 503, 520, 521, 522, 523, 524];
const GENERIC_REJECT_METADATA_TITLE_INCLUDES = ['please wait for verification'];

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': `Content-Type, X-VS-Source-Url, X-VS-File-Name, X-VS-Metadata-Source, X-VS-Client-Key, ${IMPORT_TOKEN_HEADER}`,
	'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
};

type RemoteMediaUploadBody = {
	remoteUrl: string;
	sourcePageUrl?: string;
	fileName?: string;
};

const mediaMimeAllowList = ['image/', 'video/', 'audio/'];

function appendCorsHeaders(headers: Headers) {
	for (const [key, value] of Object.entries(corsHeaders)) {
		headers.set(key, value);
	}
}

function getKv(env: Env): KVNamespace {
	if (!env.KV) throw new Error('KV binding is not configured.');
	return env.KV;
}

function getR2(env: Env): R2Bucket {
	if (!env.R2) throw new Error('R2 binding is not configured.');
	return env.R2;
}

async function enforceIpRateLimit(
	request: Request,
	env: Env,
	scope: string,
	limit: { windowSeconds: number; maxRequests: number }
): Promise<Response | null> {
	if (request.method === 'OPTIONS') return null;
	const ip = getClientIp(request);
	const windowId = Math.floor(Date.now() / (limit.windowSeconds * 1000));
	const key = `rl:v1:${scope}:${ip}:${windowId}`;
	try {
		const kv = getKv(env);
		const current = Number((await kv.get(key)) || '0');
		const next = current + 1;
		await kv.put(key, String(next), { expirationTtl: limit.windowSeconds * 2 });
		if (next <= limit.maxRequests) return null;
		const headers = new Headers({
			'Content-Type': 'application/json',
			'Retry-After': String(limit.windowSeconds),
			'X-RateLimit-Limit': String(limit.maxRequests),
			'X-RateLimit-Remaining': '0',
		});
		appendCorsHeaders(headers);
		return new Response(JSON.stringify({ error: 'Rate limit exceeded.' }), { status: 429, headers });
	} catch (error) {
		console.warn(`Rate limit check failed for ${scope}:`, error);
		return null;
	}
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers || {});
	headers.set('Content-Type', 'application/json');
	appendCorsHeaders(headers);
	return new Response(JSON.stringify(data), {
		...init,
		headers,
	});
}

function isYouTubeVideoId(value: string): boolean {
	return /^[a-zA-Z0-9_-]{6,20}$/.test(value);
}

function htmlEscape(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		if (char === '&') return '&amp;';
		if (char === '<') return '&lt;';
		if (char === '>') return '&gt;';
		if (char === '"') return '&quot;';
		return '&#39;';
	});
}

function handleYouTubeEmbedWrapper(request: Request, videoId: string): Response {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
	}
	if (!isYouTubeVideoId(videoId)) {
		return jsonResponse({ error: 'Invalid YouTube video id.' }, { status: 400 });
	}

	const safeVideoId = htmlEscape(videoId);
	const embedUrl = `https://www.youtube.com/embed/${safeVideoId}?controls=1&modestbranding=1&playsinline=1&rel=0`;
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>YouTube embed</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}
iframe{display:block;width:100%;height:100%;border:0;background:#000}
</style>
</head>
<body>
<iframe src="${embedUrl}" title="YouTube video player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
</body>
</html>`;
	const headers = new Headers({
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'public, s-maxage=86400, max-age=3600',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		'Content-Security-Policy':
			"default-src 'none'; style-src 'unsafe-inline'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; base-uri 'none'; form-action 'none'",
	});
	appendCorsHeaders(headers);
	return new Response(request.method === 'HEAD' ? null : html, { headers });
}

function isYouTubeMetadataUrl(value: string): boolean {
	try {
		const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
		return hostname === 'youtube.com' || hostname === 'youtu.be';
	} catch {
		return false;
	}
}

function getYouTubeVideoId(value: string): string | null {
	try {
		const parsed = new URL(value);
		const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
		if (hostname === 'youtu.be') {
			const id = parsed.pathname.split('/').filter(Boolean)[0];
			return id && isYouTubeVideoId(id) ? id : null;
		}
		if (hostname !== 'youtube.com' && hostname !== 'm.youtube.com') return null;

		const watchId = parsed.searchParams.get('v');
		if (watchId && isYouTubeVideoId(watchId)) return watchId;

		const parts = parsed.pathname.split('/').filter(Boolean);
		const marker = parts[0];
		const pathId = parts[1];
		if ((marker === 'shorts' || marker === 'embed' || marker === 'live') && pathId && isYouTubeVideoId(pathId)) {
			return pathId;
		}
		return null;
	} catch {
		return null;
	}
}

type YouTubeOEmbedResponse = {
	title?: string;
	author_name?: string;
	thumbnail_url?: string;
	thumbnail_width?: number;
	thumbnail_height?: number;
	width?: number;
	height?: number;
	provider_name?: string;
	type?: string;
};

type MetadataFetchProvenance = {
	metadataFetchSource: 'html' | 'youtube-oembed';
	metadataFetchVia: 'direct' | 'proxy';
	isProxyResponse: boolean;
	metadataProxyChannel?: string;
	metadataHtmlFetchVia?: 'direct' | 'proxy';
	metadataHtmlProxyChannel?: string;
	metadataFallbackReason?: string;
};

function numberString(value: number | undefined): string | undefined {
	if (!Number.isFinite(value)) return undefined;
	return String(Math.trunc(value as number));
}

async function fetchYouTubeOEmbedMetadata(env: Env, targetUrl: string): Promise<Record<string, unknown> | null> {
	const videoId = getYouTubeVideoId(targetUrl);
	if (!videoId) return null;

	const userAgent = selectUserAgent(env, targetUrl);
	const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
	const response = await fetch(oEmbedUrl, {
		headers: { 'User-Agent': userAgent },
		signal: AbortSignal.timeout(8000),
	});
	if (!response.ok) return null;

	const body = (await response.json()) as YouTubeOEmbedResponse;
	if (!body || typeof body.title !== 'string' || body.title.trim().length === 0) return null;

	const embedUrl = `https://www.youtube.com/embed/${videoId}`;
	const thumbnailUrl = typeof body.thumbnail_url === 'string' ? body.thumbnail_url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
	const thumbnailWidth = numberString(body.thumbnail_width);
	const thumbnailHeight = numberString(body.thumbnail_height);
	const playerWidth = numberString(body.width);
	const playerHeight = numberString(body.height);
	const title = body.title.trim();
	const author = typeof body.author_name === 'string' ? body.author_name.trim() : '';
	const description = author ? `By ${author} on YouTube` : undefined;

	const image = {
		url: thumbnailUrl,
		...(thumbnailWidth ? { width: thumbnailWidth } : {}),
		...(thumbnailHeight ? { height: thumbnailHeight } : {}),
		type: 'jpg',
	};
	const player = {
		url: embedUrl,
		type: 'text/html',
		...(playerWidth ? { width: playerWidth } : {}),
		...(playerHeight ? { height: playerHeight } : {}),
	};

	return {
		success: true,
		ogSiteName: 'YouTube',
		ogUrl: targetUrl,
		ogTitle: title,
		...(description ? { ogDescription: description } : {}),
		ogType: body.type === 'video' ? 'video.other' : 'website',
		ogVideoSecureURL: embedUrl,
		ogVideo: [player],
		twitterCard: 'player',
		twitterSite: '@youtube',
		twitterUrl: targetUrl,
		twitterTitle: title,
		...(description ? { twitterDescription: description } : {}),
		twitterImage: [{ url: thumbnailUrl }],
		twitterPlayer: [
			{
				url: embedUrl,
				...(playerWidth ? { width: playerWidth } : {}),
				...(playerHeight ? { height: playerHeight } : {}),
			},
		],
		ogImage: [image],
		favicon: 'https://www.youtube.com/favicon.ico',
		charset: 'UTF-8',
	};
}

function isHttpUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function normalizeMimeType(value: string | null | undefined): string {
	if (!value) return '';
	return value.split(';')[0].trim().toLowerCase();
}

function isAllowedMediaMime(mimeType: string): boolean {
	return mediaMimeAllowList.some((prefix) => mimeType.startsWith(prefix));
}

function isAllowedImageMime(mimeType: string): boolean {
	return mimeType.startsWith('image/');
}

function extensionFromMimeType(mimeType: string): string {
	const map: Record<string, string> = {
		'image/jpeg': 'jpg',
		'image/jpg': 'jpg',
		'image/png': 'png',
		'image/webp': 'webp',
		'image/gif': 'gif',
		'image/avif': 'avif',
		'image/svg+xml': 'svg',
		'video/mp4': 'mp4',
		'video/webm': 'webm',
		'video/ogg': 'ogv',
		'audio/mpeg': 'mp3',
		'audio/mp3': 'mp3',
		'audio/mp4': 'm4a',
		'audio/ogg': 'ogg',
		'audio/wav': 'wav',
		'audio/webm': 'webm',
	};
	return map[mimeType] || 'bin';
}

function extensionFromUrl(url: string): string | null {
	try {
		const pathname = new URL(url).pathname;
		const last = pathname.split('/').pop() || '';
		const clean = last.split('?')[0].split('#')[0];
		const extension = clean.includes('.') ? clean.split('.').pop() : '';
		if (!extension) return null;
		return extension.toLowerCase().slice(0, 12);
	} catch {
		return null;
	}
}

function extensionFromFileName(fileName?: string): string | null {
	if (!fileName) return null;
	const clean = fileName.trim().split('/').pop() || '';
	if (!clean.includes('.')) return null;
	return clean.split('.').pop()?.toLowerCase().slice(0, 12) || null;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

function isMediaImportAuthenticated(request: Request, env: Env): boolean {
	const configuredToken = `${(env as any).IMPORT_MEDIA_TOKEN || ''}`.trim();
	const allowUnauth = `${(env as any).ALLOW_UNAUTH_IMPORT_MEDIA || '0'}` === '1';
	if (!configuredToken) {
		return allowUnauth;
	}
	const providedToken = `${request.headers.get(IMPORT_TOKEN_HEADER) || ''}`.trim();
	if (!providedToken) return false;
	return timingSafeEqual(providedToken, configuredToken);
}

async function sha256Buffer(buffer: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function buildMediaKey(params: {
	hash: string;
	contentType: string;
	explicitExtension?: string | null;
	kind: 'remote' | 'binary';
}): string {
	const now = new Date();
	const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
	const mm = `${now.getUTCMonth() + 1}`.padStart(2, '0');
	const dd = `${now.getUTCDate()}`.padStart(2, '0');
	const extension = params.explicitExtension || extensionFromMimeType(params.contentType);
	const token = `${params.hash.slice(0, 22)}-${Date.now().toString(36)}`;
	return `imports/${params.kind}/${yyyy}/${mm}/${dd}/${token}.${extension}`;
}

function encodeR2KeyForPath(key: string): string {
	return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function resolvePublicR2Url(baseRequestUrl: string, key: string): string {
	return new URL(`${R2_OBJECT_PATH_PREFIX}${encodeR2KeyForPath(key)}`, baseRequestUrl).toString();
}

async function uploadRemoteMediaToR2(
	env: Env,
	baseRequestUrl: string,
	requestBody: RemoteMediaUploadBody
): Promise<{
	key: string;
	contentType: string;
	publicUrl: string;
	size: number;
}> {
	const remoteUrl = requestBody.remoteUrl;
	const sourcePageUrl = requestBody.sourcePageUrl || remoteUrl;
	const fileNameExt = extensionFromFileName(requestBody.fileName);
	const urlExt = extensionFromUrl(remoteUrl);
	const userAgent = selectUserAgent(env, remoteUrl);

	const { response } = await fetchWithProxyFallback(env, remoteUrl, {
		headers: {
			'User-Agent': userAgent,
			Referer: sourcePageUrl,
			Accept: '*/*',
		},
		signal: AbortSignal.timeout(20_000),
	}, {
		purpose: 'media-import',
	});

	if (!response.ok) {
		throw new Error(`Remote fetch failed (${response.status})`);
	}

	const contentType = normalizeMimeType(response.headers.get('content-type'));
	if (!contentType || !isAllowedMediaMime(contentType)) {
		throw new Error(`Unsupported media content type: ${contentType || 'unknown'}`);
	}

	const contentLengthHeader = response.headers.get('content-length');
	const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
	if (Number.isFinite(contentLength) && contentLength > IMPORT_MAX_UPLOAD_BYTES) {
		throw new Error('Media is larger than the configured upload limit.');
	}

	const hash = await sha256(remoteUrl);
	const key = buildMediaKey({
		hash,
		contentType,
		explicitExtension: fileNameExt || urlExt,
		kind: 'remote',
	});

	const r2 = getR2(env);
	await r2.put(key, response.body, {
		httpMetadata: { contentType },
	});

	const stored = await r2.head(key);
	return {
		key,
		contentType,
		publicUrl: resolvePublicR2Url(baseRequestUrl, key),
		size: stored?.size || contentLength || 0,
	};
}

async function uploadBinaryToR2(env: Env, baseRequestUrl: string, request: Request): Promise<{
	key: string;
	contentType: string;
	publicUrl: string;
	size: number;
}> {
	const contentType = normalizeMimeType(request.headers.get('content-type'));
	const fileNameExt = extensionFromFileName(request.headers.get('X-VS-File-Name') || undefined);
	const buffer = await request.arrayBuffer();
	if (!buffer || buffer.byteLength === 0) {
		throw new Error('Binary payload is empty.');
	}
	if (buffer.byteLength > IMPORT_MAX_UPLOAD_BYTES) {
		throw new Error('Binary payload exceeds max upload size.');
	}

	const resolvedType = isAllowedMediaMime(contentType) ? contentType : 'image/png';
	const hash = await sha256Buffer(buffer);
	const key = buildMediaKey({
		hash,
		contentType: resolvedType,
		explicitExtension: fileNameExt,
		kind: 'binary',
	});
	const r2 = getR2(env);
	await r2.put(key, buffer, {
		httpMetadata: { contentType: resolvedType },
	});
	const stored = await r2.head(key);
	return {
		key,
		contentType: resolvedType,
		publicUrl: resolvePublicR2Url(baseRequestUrl, key),
		size: stored?.size || buffer.byteLength,
	};
}

async function handleMediaImport(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders,
			},
		});
	}

	if (request.method !== 'POST') {
		return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
	}
	if (!isMediaImportAuthenticated(request, env)) {
		return jsonResponse({ error: 'UNAUTHORIZED_IMPORT_UPLOAD' }, { status: 401 });
	}

	try {
		const contentType = normalizeMimeType(request.headers.get('content-type'));

		if (contentType === 'application/json') {
			const body = (await request.json()) as RemoteMediaUploadBody;
			if (!body?.remoteUrl || !isHttpUrl(body.remoteUrl)) {
				return jsonResponse({ error: 'remoteUrl must be a valid http(s) URL.' }, { status: 400 });
			}
			const uploaded = await uploadRemoteMediaToR2(env, request.url, body);
			return jsonResponse({
				success: true,
				storageType: 's3',
				key: uploaded.key,
				url: uploaded.publicUrl,
				contentType: uploaded.contentType,
				size: uploaded.size,
				remoteUrl: body.remoteUrl,
				sourcePageUrl: body.sourcePageUrl || null,
				uploadedAt: Date.now(),
			});
		}

		const uploaded = await uploadBinaryToR2(env, request.url, request);
		return jsonResponse({
			success: true,
			storageType: 's3',
			key: uploaded.key,
			url: uploaded.publicUrl,
			contentType: uploaded.contentType,
			size: uploaded.size,
			sourcePageUrl: request.headers.get('X-VS-Source-Url') || null,
			uploadedAt: Date.now(),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('Media import failed:', message);
		return jsonResponse({ error: message }, { status: 500 });
	}
}

async function handleR2Object(request: Request, env: Env, key: string): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
	}
	if (!key) {
		return jsonResponse({ error: 'Missing R2 object key.' }, { status: 400 });
	}

	const r2 = getR2(env);
	const object = await r2.get(key);
	if (!object) {
		return jsonResponse({ error: 'R2 object not found.' }, { status: 404 });
	}

	const headers = new Headers({
		'Cache-Control': 'public, s-maxage=86400, max-age=3600',
	});
	object.writeHttpMetadata(headers);
	headers.set('ETag', object.httpEtag);
	headers.set('Content-Length', String(object.size));
	appendCorsHeaders(headers);

	return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function buildOcrImageCacheKey(baseRequestUrl: string, targetUrl: string): Promise<Request> {
	const keyUrl = new URL(`/__ocr-image-cache/${await sha256(targetUrl)}`, baseRequestUrl);
	return new Request(keyUrl.toString());
}

async function handleOcrImageProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
	}

	const requestUrl = new URL(request.url);
	const targetUrl = requestUrl.searchParams.get('url') || '';
	if (!isHttpUrl(targetUrl)) {
		return jsonResponse({ error: 'url must be a valid http(s) image URL.' }, { status: 400 });
	}

	const cache = caches.default;
	const cacheKey = await buildOcrImageCacheKey(request.url, targetUrl);
	const cached = await cache.match(cacheKey);
	if (cached) {
		const headers = new Headers(cached.headers);
		appendCorsHeaders(headers);
		return new Response(request.method === 'HEAD' ? null : cached.body, {
			status: cached.status,
			headers,
		});
	}

	const referer = requestUrl.searchParams.get('source') || targetUrl;
	const userAgent = selectUserAgent(env, targetUrl);
	const { response } = await fetchWithProxyFallback(env, targetUrl, {
		headers: {
			'User-Agent': userAgent,
			Referer: referer,
			Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9',
		},
		signal: AbortSignal.timeout(15_000),
	}, {
		purpose: 'ocr-image',
	});

	if (!response.ok) {
		return jsonResponse(
			{ error: `Failed to fetch image: ${response.status} ${response.statusText}` },
			{ status: response.status }
		);
	}

	const contentType = normalizeMimeType(response.headers.get('content-type'));
	if (!isAllowedImageMime(contentType)) {
		return jsonResponse({ error: `Unsupported image content type: ${contentType || 'unknown'}` }, { status: 415 });
	}

	const contentLength = Number(response.headers.get('content-length') || 0);
	if (Number.isFinite(contentLength) && contentLength > OCR_IMAGE_MAX_BYTES) {
		return jsonResponse({ error: 'Image exceeds OCR proxy size limit.' }, { status: 413 });
	}

	const headers = new Headers({
		'Content-Type': contentType,
		'Cache-Control': 'public, s-maxage=86400, max-age=3600',
	});
	const lengthHeader = response.headers.get('content-length');
	if (lengthHeader) headers.set('Content-Length', lengthHeader);
	appendCorsHeaders(headers);

	const proxied = new Response(request.method === 'HEAD' ? null : response.body, {
		status: 200,
		headers,
	});
	if (request.method === 'GET') {
		ctx.waitUntil(cache.put(cacheKey, proxied.clone()));
	}
	return proxied;
}

async function buildPerUrlCacheKey(baseRequestUrl: string, targetUrl: string): Promise<Request> {
	const keyUrl = new URL(`${OG_CACHE_PATH}/${await sha256(targetUrl)}`, baseRequestUrl);
	return new Request(keyUrl.toString());
}

async function buildKvKey(targetUrl: string): Promise<string> {
	return `${KV_PREFIX}${await sha256(targetUrl)}`;
}

async function getCachedOgDataForUrl(
	env: Env,
	ctx: ExecutionContext,
	baseRequestUrl: string,
	targetUrl: string
): Promise<Record<string, unknown> | null> {
	const cache = caches.default;
	const [cacheKey, kvKey] = await Promise.all([
		buildPerUrlCacheKey(baseRequestUrl, targetUrl),
		buildKvKey(targetUrl),
	]);
	const cached = await cache.match(cacheKey);
	if (cached) {
		const data = (await cached.json()) as Record<string, unknown>;
		if (isRejectedMetadata(env, targetUrl, data)) {
			ctx.waitUntil(cache.delete(cacheKey));
			ctx.waitUntil(getKv(env).delete(kvKey));
			return null;
		}
		return { ...data, isCachedResponse: true } as Record<string, unknown>;
	}

	const kv = getKv(env);
	const kvValue = await kv.get(kvKey);
	if (!kvValue) return null;

	try {
		const data = JSON.parse(kvValue) as Record<string, unknown>;
		if (isRejectedMetadata(env, targetUrl, data)) {
			ctx.waitUntil(kv.delete(kvKey));
			return null;
		}
		const headers = new Headers({
			'Content-Type': 'application/json',
			'Cache-Control': CACHE_CONTROL_VALUE,
		});
		ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), { headers })));
		return { ...data, isCachedResponse: true } as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isRejectedMetadata(env: Env, targetUrl: string, data: Record<string, unknown>): boolean {
	const targetPolicy = resolveMetadataTargetPolicy(env, targetUrl, 'hydrate');
	const rejectedFragments = [
		...GENERIC_REJECT_METADATA_TITLE_INCLUDES,
		...targetPolicy.rejectMetadataTitleIncludes,
	];
	if (rejectedFragments.length === 0) return false;

	const text = ['ogTitle', 'twitterTitle', 'title']
		.map((key) => data[key])
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (text.length === 0) return false;
	return rejectedFragments.some((fragment) => text.some((value) => value.includes(fragment)));
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
		const { response: res } = await fetchWithProxyFallback(env, imageUrl, {
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
			signal: AbortSignal.timeout(10000),
		}, {
			purpose: 'r2-image',
		});
		if (!res.ok) {
			console.error(`Failed to fetch image from ${imageUrl}. Status: ${res.status} ${res.statusText}`);
			return false;
		}

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

async function rewriteMetadataImagesToR2(
	env: Env,
	ctx: ExecutionContext,
	resultObj: Record<string, unknown>,
	originalUserAgent: string,
	refererUrl: string,
	baseRequestUrl: string,
	refreshImage: boolean
): Promise<Record<string, unknown>> {
	const processField = async (field: 'ogImage' | 'twitterImage') => {
		const arr = resultObj[field] as unknown;
		if (!Array.isArray(arr)) return;
		const newArr = await Promise.all(
			arr.map(async (item: unknown) => {
				const obj = (item as Record<string, unknown>) || {};
				const urlVal = obj['url'];
				if (typeof urlVal !== 'string' || urlVal.length === 0) return obj;
				console.log(`Original metadata image URL: ${urlVal}`);
				const key = `igimg/${await sha256(urlVal)}.jpg`;
				if (await ensureR2Image(env, key, urlVal, originalUserAgent, refererUrl, refreshImage)) {
					const r2Url = resolvePublicR2Url(baseRequestUrl, key);
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

async function writeMetadataToCaches(
	env: Env,
	ctx: ExecutionContext,
	baseRequestUrl: string,
	targetUrl: string,
	data: Record<string, unknown>
): Promise<void> {
	const cache = caches.default;
	const [cacheKey, kvKey] = await Promise.all([
		buildPerUrlCacheKey(baseRequestUrl, targetUrl),
		buildKvKey(targetUrl),
	]);
	const kv = getKv(env);
	const headers = new Headers({
		'Content-Type': 'application/json',
		'Cache-Control': CACHE_CONTROL_VALUE,
	});
	const writes: Promise<unknown>[] = [
		cache.put(cacheKey, new Response(JSON.stringify(data), { headers })),
		kv.put(kvKey, JSON.stringify(data), { expirationTtl: TEN_DAYS_SECONDS }),
	];
	const canonicalUrl = data['canonicalUrl'];
	if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
		try {
			const [canonicalCacheKey, canonicalKvKey] = await Promise.all([
				buildPerUrlCacheKey(baseRequestUrl, canonicalUrl),
				buildKvKey(canonicalUrl),
			]);
			writes.push(cache.put(canonicalCacheKey, new Response(JSON.stringify(data), { headers })));
			writes.push(kv.put(canonicalKvKey, JSON.stringify(data), { expirationTtl: TEN_DAYS_SECONDS }));
		} catch (e) {
			console.warn('Failed to build/write canonical cache key:', e);
		}
	}
	ctx.waitUntil(Promise.all(writes));
}

async function getOgDataForUrl(
	env: Env,
	ctx: ExecutionContext,
	baseRequestUrl: string,
	targetUrl: string,
	refresh: boolean,
	refreshImage: boolean,
	options: { forceProxy?: boolean; retryingRejectedMetadata?: boolean } = {}
): Promise<Record<string, unknown>> {
	if (!refresh) {
		const cached = await getCachedOgDataForUrl(env, ctx, baseRequestUrl, targetUrl);
		if (cached) return cached;
	}

	const userAgent = selectUserAgent(env, targetUrl);
	const targetPolicy = resolveMetadataTargetPolicy(env, targetUrl, 'hydrate');
	const forceProxy = options.forceProxy === true || targetPolicy.proxyMode === 'required';
	let response: Response;
	let htmlFetchVia: 'direct' | 'proxy' = 'direct';
	let htmlProxyChannel: string | undefined;
	try {
		const fetched = await fetchWithProxyFallback(env, targetUrl, {
			headers: buildMetadataHtmlRequestHeaders({ userAgent, refresh }),
			signal: AbortSignal.timeout(10000),
		}, {
			purpose: 'metadata-html',
			fallbackStatuses: isYouTubeMetadataUrl(targetUrl) ? YOUTUBE_METADATA_FALLBACK_STATUSES : undefined,
			forceProxy,
		});
		response = fetched.response;
		htmlFetchVia = fetched.via;
		htmlProxyChannel = fetched.channel;
		if (fetched.via === 'proxy') {
			console.log(`Metadata fetch used proxy channel ${fetched.channel} for ${targetUrl}`);
		}
	} catch (error) {
		throw new MetadataFetchError(`Failed to fetch ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`, {
			retryable: true,
		});
	}

	if (!response.ok) {
		try {
			const youtubeFallback = await fetchYouTubeOEmbedMetadata(env, targetUrl);
			if (youtubeFallback) {
				const provenance: MetadataFetchProvenance = {
					metadataFetchSource: 'youtube-oembed',
					metadataFetchVia: 'direct',
					isProxyResponse: false,
					metadataHtmlFetchVia: htmlFetchVia,
					...(htmlProxyChannel ? { metadataHtmlProxyChannel: htmlProxyChannel } : {}),
					metadataFallbackReason: `metadata-html ${response.status} ${response.statusText}`,
				};
				const data = { url: targetUrl, ...youtubeFallback, ...provenance } as Record<string, unknown>;
				await writeMetadataToCaches(env, ctx, baseRequestUrl, targetUrl, data);
				return { ...data, isCachedResponse: false } as Record<string, unknown>;
			}
		} catch (error) {
			console.warn(`YouTube oEmbed metadata fallback failed for ${targetUrl}:`, error);
		}
		throw new MetadataFetchError(`Failed to fetch ${targetUrl}: ${response.status} ${response.statusText}`, {
			status: response.status,
			retryable: isRetryableHttpStatus(env, response.status),
			retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('Retry-After')),
		});
	}

	const html = await response.text();
	const ogs = await getOpenGraphScraper();
	const { result, error } = await ogs({ html });

	if (error) {
		console.warn(`OGS reported error for ${targetUrl}:`, result);
	}

	let resultObj = { ...(result as Record<string, unknown>) } as Record<string, unknown>;
	if (isRejectedMetadata(env, targetUrl, resultObj)) {
		if (htmlFetchVia === 'direct' && !forceProxy && !options.retryingRejectedMetadata) {
			return getOgDataForUrl(env, ctx, baseRequestUrl, targetUrl, true, refreshImage, {
				forceProxy: true,
				retryingRejectedMetadata: true,
			});
		}
		throw new MetadataFetchError(`Metadata response was rejected by the policy for ${targetUrl}.`, {
			retryable: true,
			metadataFetchVia: htmlFetchVia,
			metadataProxyChannel: htmlProxyChannel,
		});
	}

	try {
		if (resolveMetadataTargetPolicy(env, targetUrl, 'hydrate').rewriteImagesToR2) {
			resultObj = await rewriteMetadataImagesToR2(env, ctx, resultObj, userAgent, targetUrl, baseRequestUrl, refreshImage);
		}
	} catch (e) {
		console.error(`Metadata image rewrite failed for ${targetUrl}:`, e);
	}

	const provenance: MetadataFetchProvenance = {
		metadataFetchSource: 'html',
		metadataFetchVia: htmlFetchVia,
		isProxyResponse: htmlFetchVia === 'proxy',
		...(htmlProxyChannel ? { metadataProxyChannel: htmlProxyChannel } : {}),
	};
	const data = { url: targetUrl, ...resultObj, ...provenance } as Record<string, unknown>;
	await writeMetadataToCaches(env, ctx, baseRequestUrl, targetUrl, data);

	return { ...data, isCachedResponse: false } as Record<string, unknown>;
}

async function buildResponse(
	env: Env,
	ctx: ExecutionContext,
	urls: string[],
	baseRequestUrl: string,
	refresh: boolean,
	refreshImage: boolean,
	cacheOnly: boolean,
	requestContext: MetadataRequestContext
): Promise<Response> {
	const policy = getMetadataPolicy(env);
	const queuedEntry = (u: string, mode: MetadataQueueMode, status: 'pending' | 'queued' | 'duplicate') => {
		const targetPolicy = resolveMetadataTargetPolicy(env, u, mode);
		return {
			url: u,
			success: true,
			metadataQueued: true,
			isMetadataQueued: true,
			metadataQueueStatus: status,
			metadataQueueMode: mode,
			metadataJobId: requestContext.jobId,
			metadataClientKey: requestContext.clientKey,
			metadataSource: requestContext.source,
			metadataBucket: targetPolicy.bucket,
			metadataPriority: targetPolicy.priority,
			retryAfterSeconds: targetPolicy.pollAfterSeconds,
		};
	};

	if (cacheOnly) {
		let pendingCount = 0;
		let retryAfterSeconds = policy.defaultPollAfterSeconds;
		const results = await Promise.all(
			urls.map(async (u) => {
				const cached = await getCachedOgDataForUrl(env, ctx, baseRequestUrl, u);
				if (cached) return cached;
				pendingCount += 1;
				const queued = queuedEntry(u, 'hydrate', 'pending');
				retryAfterSeconds = Math.max(retryAfterSeconds, queued.retryAfterSeconds);
				return queued;
			})
		);
		return new Response(JSON.stringify(results), {
			status: pendingCount > 0 ? 202 : 200,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
				'Retry-After': String(retryAfterSeconds),
			},
		});
	}

	if (refresh && urls.length > policy.inlineLimit) {
		try {
			const { queued, skipped, retryAfterSeconds } = await enqueueMetadataJobs(env, urls, {
				baseRequestUrl,
				mode: 'refresh',
				refreshImage,
				clientKey: requestContext.clientKey,
				jobId: requestContext.jobId,
				source: requestContext.source,
			});
			const queuedSet = new Set(queued);
			const results = await Promise.all(
				urls.map(async (u) => {
					const cached = await getCachedOgDataForUrl(env, ctx, baseRequestUrl, u);
					return {
						...(cached || {}),
						...queuedEntry(u, 'refresh', queuedSet.has(u) ? 'queued' : 'duplicate'),
					};
				})
			);
			return new Response(JSON.stringify(results), {
				status: 202,
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-store',
					'Retry-After': String(retryAfterSeconds),
					'X-Metadata-Queued': String(queued.length),
					'X-Metadata-Skipped': String(skipped.length),
					'X-Metadata-Queue-Mode': 'refresh',
					'X-Metadata-Job-Id': requestContext.jobId,
				},
			});
		} catch (error) {
			return jsonResponse(
				{
					error: 'Metadata queue is not available.',
					detail: error instanceof Error ? error.message : String(error),
				},
				{ status: 503 }
			);
		}
	}

	if (!refresh && urls.length > policy.inlineLimit) {
		const cachedByUrl = new Map<string, Record<string, unknown>>();
		const missingUrls: string[] = [];
		await Promise.all(
			urls.map(async (u) => {
				const cached = await getCachedOgDataForUrl(env, ctx, baseRequestUrl, u);
				if (cached) {
					cachedByUrl.set(u, cached);
					return;
				}
				missingUrls.push(u);
			})
		);

		if (missingUrls.length > 0) {
			try {
				const { queued, skipped, retryAfterSeconds } = await enqueueMetadataJobs(env, missingUrls, {
					baseRequestUrl,
					mode: 'hydrate',
					refreshImage: false,
					clientKey: requestContext.clientKey,
					jobId: requestContext.jobId,
					source: requestContext.source,
				});
				const queuedSet = new Set(queued);
				const results = urls.map((u) => {
					const cached = cachedByUrl.get(u);
					if (cached) return cached;
					return queuedEntry(u, 'hydrate', queuedSet.has(u) ? 'queued' : 'duplicate');
				});
				return new Response(JSON.stringify(results), {
					status: 202,
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'no-store',
						'Retry-After': String(retryAfterSeconds),
						'X-Metadata-Queued': String(queued.length),
						'X-Metadata-Skipped': String(skipped.length),
						'X-Metadata-Queue-Mode': 'hydrate',
						'X-Metadata-Job-Id': requestContext.jobId,
					},
				});
			} catch (error) {
				return jsonResponse(
					{
						error: 'Metadata queue is not available.',
						detail: error instanceof Error ? error.message : String(error),
					},
					{ status: 503 }
				);
			}
		}

		return new Response(JSON.stringify(urls.map((u) => cachedByUrl.get(u))), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': CACHE_CONTROL_VALUE,
			},
		});
	}

	const results = await Promise.all(
		urls.map(async (u) => {
			try {
				return await getOgDataForUrl(env, ctx, baseRequestUrl, u, refresh, refreshImage);
			} catch (error) {
				const metadataError = error instanceof MetadataFetchError ? error : null;
				return {
					url: u,
					error: error instanceof Error ? error.message : String(error),
					...(metadataError?.metadataFetchVia ? { metadataFetchVia: metadataError.metadataFetchVia } : {}),
					...(metadataError?.metadataFetchVia === 'proxy' ? { isProxyResponse: true } : {}),
					...(metadataError?.metadataProxyChannel
						? { metadataProxyChannel: metadataError.metadataProxyChannel }
						: {}),
				};
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

type MetadataRequestInput = {
	urls: string[];
	revalidate: boolean;
	refreshImage: boolean;
	cacheOnly: boolean;
};

async function readMetadataRequestInput(request: Request, url: URL): Promise<MetadataRequestInput> {
	if (request.method === 'GET') {
		return {
			urls: url.searchParams.getAll('url'),
			revalidate: url.searchParams.has('re'),
			refreshImage: url.searchParams.get('img') === '1',
			cacheOnly: url.searchParams.get('cache') === 'only' || url.searchParams.get('co') === '1',
		};
	}
	if (request.method !== 'POST') throw new Error('METHOD_NOT_ALLOWED');
	const contentLength = Number(request.headers.get('Content-Length') || 0);
	if (Number.isFinite(contentLength) && contentLength > 128 * 1024) {
		throw new Error('METADATA_REQUEST_BODY_TOO_LARGE');
	}
	const body = (await request.json()) as Record<string, unknown>;
	return {
		urls: Array.isArray(body.urls) ? body.urls.filter((value): value is string => typeof value === 'string') : [],
		revalidate: body.revalidate === true,
		refreshImage: body.refreshImage === true,
		cacheOnly: body.cacheOnly === true,
	};
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}
		if (url.pathname.startsWith(YOUTUBE_EMBED_PATH_PREFIX)) {
			const videoId = decodeURIComponent(url.pathname.slice(YOUTUBE_EMBED_PATH_PREFIX.length)).split('/')[0] || '';
			return handleYouTubeEmbedWrapper(request, videoId);
		}
		if (url.pathname.startsWith(R2_OBJECT_PATH_PREFIX)) {
			try {
				const limited = await enforceIpRateLimit(request, env, 'r2-object', R2_OBJECT_RATE_LIMIT);
				if (limited) return limited;
				const key = decodeURIComponent(url.pathname.slice(R2_OBJECT_PATH_PREFIX.length));
				return await handleR2Object(request, env, key);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error(errorMessage);
				return jsonResponse({ error: errorMessage }, { status: 500 });
			}
		}
		if (url.pathname === IMPORT_MEDIA_UPLOAD_PATH) {
			return handleMediaImport(request, env);
		}
		const ocrModelId = resolveOcrModelId(url.pathname);
		if (ocrModelId) {
			try {
				const limited = await enforceIpRateLimit(request, env, 'ocr-model', OCR_MODEL_RATE_LIMIT);
				if (limited) return limited;
				return await handleOcrModel(request, env, ocrModelId);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error(errorMessage);
				return jsonResponse({ error: errorMessage }, { status: 500 });
			}
		}
		if (url.pathname === OCR_IMAGE_PROXY_PATH) {
			try {
				const limited = await enforceIpRateLimit(request, env, 'ocr-image', OCR_IMAGE_RATE_LIMIT);
				if (limited) return limited;
				return await handleOcrImageProxy(request, env, ctx);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error(errorMessage);
				return jsonResponse({ error: errorMessage }, { status: 500 });
			}
		}
		let metadataInput: MetadataRequestInput;
		try {
			metadataInput = await readMetadataRequestInput(request, url);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Invalid metadata request.';
			return jsonResponse({ error: message }, { status: message === 'METHOD_NOT_ALLOWED' ? 405 : 400 });
		}
		const urlsToScrape = metadataInput.urls;

		if (urlsToScrape.length === 0) {
			return jsonResponse({ error: "Please provide at least one 'url' query parameter." }, { status: 400 });
		}

		const policy = getMetadataPolicy(env);
		if (urlsToScrape.length > policy.maxUrlsPerRequest) {
			return jsonResponse(
				{
					error: 'Too many URLs in one metadata request.',
					maxUrlsPerRequest: policy.maxUrlsPerRequest,
					receivedUrls: urlsToScrape.length,
				},
				{ status: 400 }
			);
		}

		const urls = urlsToScrape.map((u) => u.trim().replace(/^https?:\/\/https?:\/\//, 'https://'));

		try {
			const refresh = metadataInput.revalidate;
			const refreshImage = metadataInput.refreshImage;
			const cacheOnly = metadataInput.cacheOnly;
			const requestContext = await getMetadataRequestContext(request, url);
			const response = await buildResponse(env, ctx, urls, request.url, refresh, refreshImage, cacheOnly, requestContext);
			appendCorsHeaders(response.headers);
			return response;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(errorMessage);
			return jsonResponse({ error: errorMessage }, { status: 500 });
		}
	},

	async queue(batch: MessageBatch<MetadataQueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
		await processMetadataQueue(batch, env, async (message) => {
			await getOgDataForUrl(env, ctx, message.baseRequestUrl, message.url, message.mode === 'refresh', message.refreshImage);
		});
	},
} satisfies ExportedHandler<Env, MetadataQueueMessage>;
