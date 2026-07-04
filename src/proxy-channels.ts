import { fetchViaHttpProxyTunnel, type HttpConnectProxy } from './http-proxy-tunnel';

export type OutboundFetchPurpose = 'metadata-html' | 'media-import' | 'ocr-image' | 'r2-image';

type ProxyTargetMode = 'query' | 'prefix' | 'header' | 'json-body';
type ProxyChannelType = 'fetch-api' | 'service-binding' | 'http-connect' | 'socks5' | 'dataimpulse';

type BaseProxyChannel = {
	name: string;
	type?: ProxyChannelType;
	domains?: string[];
	purposes?: OutboundFetchPurpose[];
	fallbackStatuses?: number[];
	disabled?: boolean;
};

export type FetchApiProxyChannel = BaseProxyChannel & {
	type: 'fetch-api';
	endpoint: string;
	method?: 'GET' | 'POST';
	targetMode?: ProxyTargetMode;
	urlParam?: string;
	targetHeader?: string;
	authHeader?: string;
	authTokenEnv?: string;
	headers?: Record<string, string>;
};

export type ServiceBindingProxyChannel = BaseProxyChannel & {
	type: 'service-binding';
	binding: string;
	path?: string;
	targetMode?: ProxyTargetMode;
	urlParam?: string;
	targetHeader?: string;
	headers?: Record<string, string>;
};

export type HttpConnectProxyChannel = BaseProxyChannel & {
	type: 'http-connect';
	host?: string;
	port?: number;
	proxyUrl?: string;
	proxyUrlEnv?: string;
	username?: string;
	password?: string;
	usernameEnv?: string;
	passwordEnv?: string;
	headers?: Record<string, string>;
	connectTimeoutMs?: number;
	readTimeoutMs?: number;
	maxBodyBytes?: number;
};

export type Socks5ProxyChannel = BaseProxyChannel & {
	type: 'socks5';
	host?: string;
	port?: number;
	proxyUrl?: string;
	proxyUrlEnv?: string;
	username?: string;
	password?: string;
	usernameEnv?: string;
	passwordEnv?: string;
};

export type DataImpulseProxyChannel = Omit<HttpConnectProxyChannel, 'type' | 'host' | 'port'> & {
	type: 'dataimpulse';
	host?: string;
	port?: number;
};

export type ProxyChannel =
	| FetchApiProxyChannel
	| ServiceBindingProxyChannel
	| HttpConnectProxyChannel
	| Socks5ProxyChannel
	| DataImpulseProxyChannel;

export type NormalizedProxyChannel =
	| FetchApiProxyChannel
	| ServiceBindingProxyChannel
	| (BaseProxyChannel & {
			type: 'http-connect';
			proxy: HttpConnectProxy;
			connectTimeoutMs: number;
			readTimeoutMs: number;
			maxBodyBytes?: number;
	  })
	| (BaseProxyChannel & {
			type: 'socks5';
			proxyUrl: string;
	  });

type ProxyChannelConfig = ProxyChannel[] | { channels?: ProxyChannel[] };

const DATAIMPULSE_HOST = 'gw.dataimpulse.com';
const DATAIMPULSE_PORT = 823;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

function getEnvString(env: Env, key: string): string {
	const value = (env as unknown as Record<string, unknown>)[key];
	return typeof value === 'string' ? value.trim() : '';
}

export function isOutboundFetchPurpose(value: string): value is OutboundFetchPurpose {
	return value === 'metadata-html' || value === 'media-import' || value === 'ocr-image' || value === 'r2-image';
}

export function getEnabledProxyPurposes(env: Env): Set<OutboundFetchPurpose> | null {
	const raw = getEnvString(env, 'PROXY_ENABLED_PURPOSES');
	if (!raw) return null;
	const purposes = raw
		.split(',')
		.map((part) => part.trim())
		.filter((part): part is OutboundFetchPurpose => isOutboundFetchPurpose(part));
	return purposes.length > 0 ? new Set(purposes) : null;
}

export function parseProxyChannels(env: Env): NormalizedProxyChannel[] {
	const raw = getEnvString(env, 'PROXY_CHANNELS_JSON');
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw) as ProxyChannelConfig;
		const channels = Array.isArray(parsed) ? parsed : parsed.channels || [];
		return channels.flatMap((channel) => normalizeProxyChannel(env, channel));
	} catch (error) {
		console.warn('Invalid PROXY_CHANNELS_JSON; proxy fallback disabled.', error);
		return [];
	}
}

function normalizeProxyChannel(env: Env, value: unknown): NormalizedProxyChannel[] {
	if (!isProxyChannel(value)) return [];
	if (value.disabled) return [];

	if (value.type === 'http-connect' || value.type === 'dataimpulse') {
		const normalized = normalizeHttpConnectChannel(env, value);
		return normalized ? [normalized] : [];
	}

	if (value.type === 'socks5') {
		const normalized = normalizeSocks5Channel(env, value);
		return normalized ? [normalized] : [];
	}

	if (value.type === 'service-binding') {
		if (!isServiceBindingProxyChannel(value)) return [];
		return [value];
	}

	if (value.type === 'fetch-api' || !value.type) {
		if (!isFetchApiProxyChannel(value)) return [];
		return [{ ...value, type: 'fetch-api' }];
	}

	return [];
}

function isProxyChannel(value: unknown): value is ProxyChannel {
	if (!value || typeof value !== 'object') return false;
	const channel = value as Record<string, unknown>;
	return typeof channel.name === 'string' && channel.name.trim().length > 0;
}

function isFetchApiProxyChannel(value: ProxyChannel): value is FetchApiProxyChannel {
	return typeof (value as { endpoint?: unknown }).endpoint === 'string' && (value as FetchApiProxyChannel).endpoint.trim().length > 0;
}

function isServiceBindingProxyChannel(value: ProxyChannel): value is ServiceBindingProxyChannel {
	return typeof (value as { binding?: unknown }).binding === 'string' && (value as ServiceBindingProxyChannel).binding.trim().length > 0;
}

function normalizeHttpConnectChannel(
	env: Env,
	channel: HttpConnectProxyChannel | DataImpulseProxyChannel
): NormalizedProxyChannel | null {
	const proxy = resolveHttpConnectProxy(env, channel);
	if (!proxy) return null;
	return {
		...channel,
		type: 'http-connect',
		proxy,
		connectTimeoutMs: positiveNumber(channel.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS,
		readTimeoutMs: positiveNumber(channel.readTimeoutMs) || DEFAULT_READ_TIMEOUT_MS,
		maxBodyBytes: positiveNumber(channel.maxBodyBytes),
	};
}

function normalizeSocks5Channel(env: Env, channel: Socks5ProxyChannel): NormalizedProxyChannel | null {
	const proxyUrl = resolveSocks5ProxyUrl(env, channel);
	return proxyUrl ? { ...channel, type: 'socks5', proxyUrl } : null;
}

function resolveHttpConnectProxy(env: Env, channel: HttpConnectProxyChannel | DataImpulseProxyChannel): HttpConnectProxy | null {
	const proxyUrl = channel.proxyUrl || (channel.proxyUrlEnv ? getEnvString(env, channel.proxyUrlEnv) : '');
	if (proxyUrl) {
		return proxyFromUrl(proxyUrl, channel.headers);
	}

	const defaultHost = channel.type === 'dataimpulse' ? DATAIMPULSE_HOST : '';
	const defaultPort = channel.type === 'dataimpulse' ? DATAIMPULSE_PORT : 0;
	const hostname = (channel.host || defaultHost).trim();
	const port = positiveNumber(channel.port) || defaultPort;
	if (!hostname || !port) return null;

	const defaultUsernameEnv = channel.type === 'dataimpulse' ? 'DATAIMPULSE_USERNAME' : '';
	const defaultPasswordEnv = channel.type === 'dataimpulse' ? 'DATAIMPULSE_PASSWORD' : '';
	const usernameEnv = channel.usernameEnv || defaultUsernameEnv;
	const passwordEnv = channel.passwordEnv || defaultPasswordEnv;
	const username = channel.username || (usernameEnv ? getEnvString(env, usernameEnv) : '');
	const password = channel.password || (passwordEnv ? getEnvString(env, passwordEnv) : '');

	return {
		hostname,
		port,
		username,
		password,
		headers: channel.headers,
	};
}

function resolveSocks5ProxyUrl(env: Env, channel: Socks5ProxyChannel): string | null {
	const configuredUrl = channel.proxyUrl || (channel.proxyUrlEnv ? getEnvString(env, channel.proxyUrlEnv) : '');
	if (configuredUrl) {
		try {
			const url = new URL(configuredUrl);
			return url.protocol === 'socks5:' ? url.toString() : null;
		} catch {
			return null;
		}
	}

	const hostname = channel.host?.trim();
	const port = positiveNumber(channel.port);
	if (!hostname || !port) return null;
	const username = channel.username || (channel.usernameEnv ? getEnvString(env, channel.usernameEnv) : '');
	const password = channel.password || (channel.passwordEnv ? getEnvString(env, channel.passwordEnv) : '');
	const credentials = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
	return `socks5://${credentials}${hostname}:${port}`;
}

function proxyFromUrl(proxyUrl: string, headers?: Record<string, string>): HttpConnectProxy | null {
	try {
		const url = new URL(proxyUrl);
		if (url.protocol !== 'http:') return null;
		return {
			hostname: url.hostname,
			port: Number(url.port || 80),
			username: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password),
			headers,
		};
	} catch {
		return null;
	}
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function channelSupportsTarget(channel: NormalizedProxyChannel, targetUrl: string, purpose: OutboundFetchPurpose): boolean {
	if (channel.disabled) return false;
	if (channel.purposes && !channel.purposes.includes(purpose)) return false;
	if (!channel.domains || channel.domains.length === 0) return true;

	try {
		const hostname = new URL(targetUrl).hostname.toLowerCase();
		return channel.domains.some((domain) => hostMatchesDomain(hostname, domain));
	} catch {
		return false;
	}
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	const normalized = domain.trim().toLowerCase();
	return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

export async function fetchThroughProxyChannel(
	env: Env,
	channel: NormalizedProxyChannel,
	targetUrl: string,
	init: RequestInit,
	purpose: OutboundFetchPurpose
): Promise<Response> {
	if (channel.type === 'http-connect') {
		return fetchViaHttpProxyTunnel({
			targetUrl,
			init,
			proxy: channel.proxy,
			connectTimeoutMs: channel.connectTimeoutMs,
			readTimeoutMs: channel.readTimeoutMs,
			maxBodyBytes: channel.maxBodyBytes || maxBodyBytesForPurpose(purpose),
		});
	}

	if (channel.type === 'socks5') {
		const { socksFetch } = await import('cf-fetch-socks');
		return socksFetch(targetUrl, { ...init, proxy: channel.proxyUrl });
	}

	if (channel.type === 'service-binding') {
		return fetchThroughServiceBinding(env, channel, targetUrl, init);
	}

	return fetch(buildFetchApiProxyRequestUrl(channel, targetUrl), buildFetchApiProxyInit(env, channel, targetUrl, init));
}

function maxBodyBytesForPurpose(purpose: OutboundFetchPurpose): number {
	if (purpose === 'ocr-image') return 12 * 1024 * 1024;
	if (purpose === 'media-import') return 60 * 1024 * 1024;
	return DEFAULT_MAX_BODY_BYTES;
}

function getFetchApiHeaders(env: Env, channel: FetchApiProxyChannel, baseHeaders: HeadersInit | undefined): Headers {
	const headers = new Headers(baseHeaders);
	for (const [key, value] of Object.entries(channel.headers || {})) {
		headers.set(key, value);
	}

	if (channel.authHeader && channel.authTokenEnv) {
		const token = getEnvString(env, channel.authTokenEnv);
		if (token) headers.set(channel.authHeader, token);
	}

	return headers;
}

function getChannelHeaders(channel: { headers?: Record<string, string> }, baseHeaders: HeadersInit | undefined): Headers {
	const headers = new Headers(baseHeaders);
	for (const [key, value] of Object.entries(channel.headers || {})) {
		headers.set(key, value);
	}
	return headers;
}

function buildFetchApiProxyRequestUrl(channel: FetchApiProxyChannel, targetUrl: string): string {
	const targetMode = channel.targetMode || 'query';
	if (targetMode === 'prefix') {
		return `${channel.endpoint}${encodeURIComponent(targetUrl)}`;
	}

	if (targetMode === 'header' || targetMode === 'json-body') {
		return channel.endpoint;
	}

	const proxyUrl = new URL(channel.endpoint);
	proxyUrl.searchParams.set(channel.urlParam || 'url', targetUrl);
	return proxyUrl.toString();
}

function buildServiceBindingRequestUrl(channel: ServiceBindingProxyChannel, targetUrl: string): string {
	const targetMode = channel.targetMode || 'json-body';
	const path = channel.path || '/';
	const basePath = path.startsWith('/') ? path : `/${path}`;
	const requestUrl = new URL(basePath, 'https://proxy-channel.service');
	if (targetMode === 'prefix') {
		return new URL(`${basePath}${encodeURIComponent(targetUrl)}`, 'https://proxy-channel.service').toString();
	}
	if (targetMode === 'query') {
		requestUrl.searchParams.set(channel.urlParam || 'url', targetUrl);
	}
	return requestUrl.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		out[key] = value;
	}
	return out;
}

function buildFetchApiProxyInit(env: Env, channel: FetchApiProxyChannel, targetUrl: string, init: RequestInit): RequestInit {
	const targetMode = channel.targetMode || 'query';
	const originalHeaders = new Headers(init.headers);
	const headers = getFetchApiHeaders(env, channel, targetMode === 'json-body' ? undefined : init.headers);

	if (targetMode === 'header') {
		headers.set(channel.targetHeader || 'X-Target-Url', targetUrl);
	}

	if (targetMode === 'json-body') {
		headers.set('Content-Type', 'application/json');
		return {
			...init,
			method: channel.method || 'POST',
			headers,
			body: JSON.stringify({
				url: targetUrl,
				method: init.method || 'GET',
				headers: headersToRecord(originalHeaders),
			}),
		};
	}

	return {
		...init,
		method: channel.method || init.method || 'GET',
		headers,
	};
}

function buildServiceBindingProxyInit(channel: ServiceBindingProxyChannel, targetUrl: string, init: RequestInit): RequestInit {
	const targetMode = channel.targetMode || 'json-body';
	const originalHeaders = new Headers(init.headers);
	const headers = getChannelHeaders(channel, targetMode === 'json-body' ? undefined : init.headers);

	if (targetMode === 'header') {
		headers.set(channel.targetHeader || 'X-Target-Url', targetUrl);
	}

	if (targetMode === 'json-body') {
		headers.set('Content-Type', 'application/json');
		return {
			...init,
			method: 'POST',
			headers,
			body: JSON.stringify({
				url: targetUrl,
				method: init.method || 'GET',
				headers: headersToRecord(originalHeaders),
			}),
		};
	}

	return {
		...init,
		method: init.method || 'GET',
		headers,
	};
}

function getServiceBinding(env: Env, bindingName: string): { fetch: (request: Request) => Promise<Response> } {
	const binding = (env as unknown as Record<string, unknown>)[bindingName];
	if (!binding || typeof binding !== 'object' || typeof (binding as { fetch?: unknown }).fetch !== 'function') {
		throw new Error(`Proxy service binding "${bindingName}" is not configured.`);
	}
	return binding as { fetch: (request: Request) => Promise<Response> };
}

function fetchThroughServiceBinding(
	env: Env,
	channel: ServiceBindingProxyChannel,
	targetUrl: string,
	init: RequestInit
): Promise<Response> {
	const binding = getServiceBinding(env, channel.binding);
	const request = new Request(
		buildServiceBindingRequestUrl(channel, targetUrl),
		buildServiceBindingProxyInit(channel, targetUrl, init)
	);
	return binding.fetch(request);
}
