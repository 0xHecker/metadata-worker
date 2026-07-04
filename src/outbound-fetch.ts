import {
	channelSupportsTarget,
	fetchThroughProxyChannel,
	getEnabledProxyPurposes,
	parseProxyChannels,
	type OutboundFetchPurpose,
} from './proxy-channels';

export type { OutboundFetchPurpose } from './proxy-channels';

type OutboundFetchOptions = {
	purpose: OutboundFetchPurpose;
	fallbackStatuses?: number[];
	forceProxy?: boolean;
};

export type OutboundFetchResult = {
	response: Response;
	via: 'direct' | 'proxy';
	channel?: string;
};

const DEFAULT_FALLBACK_STATUSES = [403, 407, 408, 409, 425, 429, 451, 503, 520, 521, 522, 523, 524];
const RETRY_AFTER_MIN_SECONDS = 30;
const RETRY_AFTER_MAX_SECONDS = 900;
const PROXY_TIMEOUTS_MS: Record<OutboundFetchPurpose, number> = {
	'metadata-html': 15_000,
	'media-import': 30_000,
	'ocr-image': 20_000,
	'r2-image': 20_000,
};

function getEnvString(env: Env, key: string): string {
	const value = (env as unknown as Record<string, unknown>)[key];
	return typeof value === 'string' ? value.trim() : '';
}

function parseStatusList(raw: string): number[] {
	return raw
		.split(',')
		.map((part) => Number(part.trim()))
		.filter((status) => Number.isInteger(status) && status >= 400 && status <= 599);
}

function getFallbackStatuses(env: Env): number[] {
	const configured = parseStatusList(getEnvString(env, 'PROXY_FALLBACK_STATUSES'));
	return configured.length > 0 ? configured : DEFAULT_FALLBACK_STATUSES;
}

export function isRetryableHttpStatus(env: Env, status: number): boolean {
	return getFallbackStatuses(env).includes(status);
}

export function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds > 0) {
		return clampRetryAfterSeconds(seconds);
	}

	const retryAt = Date.parse(value);
	if (!Number.isFinite(retryAt)) return undefined;
	return clampRetryAfterSeconds(Math.ceil((retryAt - Date.now()) / 1000));
}

function clampRetryAfterSeconds(seconds: number): number {
	if (seconds <= 0) return RETRY_AFTER_MIN_SECONDS;
	return Math.max(RETRY_AFTER_MIN_SECONDS, Math.min(RETRY_AFTER_MAX_SECONDS, Math.ceil(seconds)));
}

function shouldFallback(status: number, statuses: number[]): boolean {
	return statuses.includes(status);
}

function isRetryableNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const name = error.name.toLowerCase();
	const message = error.message.toLowerCase();
	return (
		name.includes('timeout') ||
		name.includes('abort') ||
		name.includes('network') ||
		message.includes('fetch failed') ||
		message.includes('timed out')
	);
}

function buildProxyInit(init: RequestInit, purpose: OutboundFetchPurpose): RequestInit {
	const proxyInit = { ...init };
	const signal = proxyInit.signal;
	if (!signal || signal.aborted) {
		proxyInit.signal = AbortSignal.timeout(PROXY_TIMEOUTS_MS[purpose]);
	}
	return proxyInit;
}

async function cancelBody(response: Response): Promise<void> {
	if (!response.body) return;
	await response.body.cancel().catch(() => undefined);
}

async function fetchFromProxyChannels(
	env: Env,
	targetUrl: string,
	init: RequestInit,
	purpose: OutboundFetchPurpose,
	fallbackStatuses: number[]
): Promise<OutboundFetchResult | null> {
	const channels = parseProxyChannels(env).filter((channel) => channelSupportsTarget(channel, targetUrl, purpose));

	for (const channel of channels) {
		const channelStatuses = channel.fallbackStatuses || fallbackStatuses;
		try {
			const proxyResponse = await fetchThroughProxyChannel(
				env,
				channel,
				targetUrl,
				buildProxyInit(init, purpose),
				purpose
			);
			if (shouldFallback(proxyResponse.status, channelStatuses)) {
				await cancelBody(proxyResponse);
				continue;
			}
			return {
				response: proxyResponse,
				via: 'proxy',
				channel: channel.name,
			};
		} catch (error) {
			console.warn(`Proxy channel failed for ${targetUrl}:`, channel.name, error);
		}
	}

	return null;
}

export async function fetchWithProxyFallback(
	env: Env,
	targetUrl: string,
	init: RequestInit,
	options: OutboundFetchOptions
): Promise<OutboundFetchResult> {
	let directError: unknown = null;
	let directResponse: Response | null = null;
	const fallbackStatuses = options.fallbackStatuses || getFallbackStatuses(env);
	const enabledPurposes = getEnabledProxyPurposes(env);
	if (enabledPurposes && !enabledPurposes.has(options.purpose)) {
		if (options.forceProxy) {
			throw new Error(`Proxy use is required for ${targetUrl}, but ${options.purpose} is disabled.`);
		}
		return fetchDirect(targetUrl, init);
	}

	if (options.forceProxy) {
		const proxied = await fetchFromProxyChannels(env, targetUrl, init, options.purpose, fallbackStatuses);
		if (proxied) return proxied;
		throw new Error(`Proxy use is required for ${targetUrl}, but no proxy channel returned a usable response.`);
	}

	// Direct fetch remains the fast path unless a domain policy explicitly requires a proxy.
	try {
		directResponse = await fetch(targetUrl, init);
		if (!shouldFallback(directResponse.status, fallbackStatuses)) {
			return { response: directResponse, via: 'direct' };
		}
	} catch (error) {
		directError = error;
		if (!isRetryableNetworkError(error)) throw error;
	}

	const proxied = await fetchFromProxyChannels(env, targetUrl, init, options.purpose, fallbackStatuses);
	if (proxied) {
		if (directResponse) await cancelBody(directResponse);
		return proxied;
	}

	if (directResponse) {
		return { response: directResponse, via: 'direct' };
	}
	throw directError instanceof Error ? directError : new Error(String(directError || 'Outbound fetch failed.'));
}

async function fetchDirect(targetUrl: string, init: RequestInit): Promise<OutboundFetchResult> {
	return { response: await fetch(targetUrl, init), via: 'direct' };
}
