import type { MetadataJobSource } from './metadata-policy';

export type MetadataRequestContext = {
	clientKey: string;
	jobId: string;
	source: MetadataJobSource;
};

export function getClientIp(request: Request): string {
	return (
		request.headers.get('CF-Connecting-IP') ||
		request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
		'unknown'
	);
}

export async function getMetadataRequestContext(request: Request, url: URL): Promise<MetadataRequestContext> {
	const sourceParam = cleanMetadataToken(url.searchParams.get('src') || request.headers.get('X-VS-Metadata-Source'), 'api');
	const source = isMetadataJobSource(sourceParam) ? sourceParam : 'api';
	const clientParam =
		url.searchParams.get('client') ||
		url.searchParams.get('clientKey') ||
		request.headers.get('X-VS-Client-Key');
	const clientKey = clientParam
		? cleanMetadataToken(clientParam, 'anonymous')
		: `anon:${(await sha256(`${getClientIp(request)}:${request.headers.get('User-Agent') || ''}`)).slice(0, 16)}`;
	const jobId = cleanMetadataToken(url.searchParams.get('job') || url.searchParams.get('jobId'), crypto.randomUUID());
	return { clientKey, jobId, source };
}

function isMetadataJobSource(value: string): value is MetadataJobSource {
	return value === 'api' || value === 'extension' || value === 'system';
}

function cleanMetadataToken(value: string | null, fallback: string): string {
	const cleaned = (value || '').trim().replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 96);
	return cleaned || fallback;
}

async function sha256(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', encoded);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

