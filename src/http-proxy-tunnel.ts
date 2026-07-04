import { connect } from 'cloudflare:sockets';

export type HttpConnectProxy = {
	hostname: string;
	port: number;
	username?: string;
	password?: string;
	headers?: Record<string, string>;
};

export type HttpProxyTunnelRequest = {
	targetUrl: string;
	init: RequestInit;
	proxy: HttpConnectProxy;
	connectTimeoutMs: number;
	readTimeoutMs: number;
	maxBodyBytes: number;
};

type ParsedHttpResponse = {
	status: number;
	statusText: string;
	headers: Headers;
	body: Uint8Array<ArrayBuffer>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRLF = '\r\n';
const HEADER_END = '\r\n\r\n';
const MAX_HEADER_BYTES = 64 * 1024;

export async function fetchViaHttpProxyTunnel(request: HttpProxyTunnelRequest): Promise<Response> {
	const target = new URL(request.targetUrl);
	const method = (request.init.method || 'GET').toUpperCase();
	if (method !== 'GET' && method !== 'HEAD') {
		throw new Error(`HTTP proxy tunnel only supports GET and HEAD requests, received ${method}.`);
	}
	if (request.init.body) {
		throw new Error('HTTP proxy tunnel does not support request bodies.');
	}

	const proxySocket = connect(
		{ hostname: request.proxy.hostname, port: request.proxy.port },
		{ secureTransport: 'starttls', allowHalfOpen: false }
	);
	await withTimeout(proxySocket.opened, request.connectTimeoutMs, 'Timed out connecting to HTTP proxy.');

	let socket: Socket | null = proxySocket;
	try {
		const tunnel = target.protocol === 'https:' ? await openHttpsTunnel(proxySocket, target, request) : proxySocket;
		if (tunnel instanceof Response) {
			socket = null;
			return tunnel;
		}
		socket = tunnel;
		const requestText = buildOriginRequestText(target, method, request.init.headers, request.proxy, target.protocol === 'http:');
		await writeAll(socket.writable, requestText);

		const parsed = await readHttpResponse(socket.readable, method, request.maxBodyBytes, request.readTimeoutMs);
		return new Response(parsed.body, {
			status: parsed.status,
			statusText: parsed.statusText,
			headers: parsed.headers,
		});
	} finally {
		await socket?.close().catch(() => undefined);
	}
}

function buildOriginRequestText(
	target: URL,
	method: string,
	sourceHeaders: HeadersInit | undefined,
	proxy: HttpConnectProxy,
	includeProxyHeaders: boolean
): string {
	const requestTarget = includeProxyHeaders ? target.toString() : `${target.pathname}${target.search}`;
	const headers = new Headers(sourceHeaders);
	headers.set('Host', hostHeader(target));
	headers.set('Connection', 'close');
	headers.set('Accept-Encoding', 'identity');
	if (includeProxyHeaders) {
		addProxyHeaders(headers, proxy);
	}
	return formatHttpRequest(method, requestTarget, headers);
}

async function openHttpsTunnel(socket: Socket, target: URL, request: HttpProxyTunnelRequest): Promise<Socket | Response> {
	const authority = proxyConnectAuthority(target);
	const connectHeaders = new Headers({
		Host: authority,
		'Proxy-Connection': 'keep-alive',
	});
	addProxyHeaders(connectHeaders, request.proxy);
	await writeAll(socket.writable, formatHttpRequest('CONNECT', authority, connectHeaders));

	const connectResponse = await readHttpHeaders(socket.readable, request.readTimeoutMs);
	if (connectResponse.leftover.byteLength > 0) {
		throw new Error('HTTP proxy returned unexpected bytes before TLS handshake.');
	}
	if (connectResponse.status < 200 || connectResponse.status >= 300) {
		await socket.close().catch(() => undefined);
		return new Response(connectResponse.body, {
			status: connectResponse.status,
			statusText: connectResponse.statusText,
			headers: connectResponse.headers,
		});
	}

	const tlsSocket = socket.startTls({ expectedServerHostname: target.hostname });
	await withTimeout(tlsSocket.opened, request.connectTimeoutMs, 'Timed out upgrading HTTP proxy tunnel to TLS.');
	return tlsSocket;
}

function addProxyHeaders(headers: Headers, proxy: HttpConnectProxy) {
	for (const [key, value] of Object.entries(proxy.headers || {})) {
		headers.set(key, value);
	}
	if (proxy.username || proxy.password) {
		headers.set('Proxy-Authorization', buildProxyAuthorization(proxy.username || '', proxy.password || ''));
	}
}

export function buildProxyAuthorization(username: string, password: string): string {
	return `Basic ${btoa(`${username}:${password}`)}`;
}

function formatHttpRequest(method: string, requestTarget: string, headers: Headers): string {
	const lines = [`${method} ${requestTarget} HTTP/1.1`];
	for (const [key, value] of headers.entries()) {
		lines.push(`${key}: ${value}`);
	}
	return `${lines.join(CRLF)}${HEADER_END}`;
}

function hostHeader(target: URL): string {
	const port = target.port || (target.protocol === 'https:' ? '443' : '80');
	const defaultPort = target.protocol === 'https:' ? '443' : '80';
	return port === defaultPort ? target.hostname : `${target.hostname}:${port}`;
}

export function proxyConnectAuthority(target: URL): string {
	const port = target.port || (target.protocol === 'https:' ? '443' : '80');
	return `${target.hostname}:${port}`;
}

async function writeAll(writable: WritableStream, text: string): Promise<void> {
	const writer = writable.getWriter();
	try {
		await writer.write(encoder.encode(text));
	} finally {
		writer.releaseLock();
	}
}

async function readHttpHeaders(
	readable: ReadableStream,
	timeoutMs: number
): Promise<ParsedHttpResponse & { leftover: Uint8Array<ArrayBuffer> }> {
	const reader = readable.getReader();
	let buffer = new Uint8Array();
	try {
		while (indexOfHeaderEnd(buffer) < 0) {
			const chunk = await readChunk(reader, timeoutMs);
			if (!chunk) throw new Error('Socket closed before HTTP headers were complete.');
			buffer = concatBytes(buffer, chunk);
			if (buffer.byteLength > MAX_HEADER_BYTES) {
				throw new Error('HTTP response headers exceeded the proxy tunnel limit.');
			}
		}
		const headerEnd = indexOfHeaderEnd(buffer);
		const headerBytes = buffer.slice(0, headerEnd);
		const leftover = buffer.slice(headerEnd + HEADER_END.length);
		return { ...parseHeaderBytes(headerBytes), body: new Uint8Array(), leftover };
	} finally {
		reader.releaseLock();
	}
}

async function readHttpResponse(
	readable: ReadableStream,
	method: string,
	maxBodyBytes: number,
	timeoutMs: number
): Promise<ParsedHttpResponse> {
	const reader = readable.getReader();
	let buffer = new Uint8Array();
	try {
		while (indexOfHeaderEnd(buffer) < 0) {
			const chunk = await readChunk(reader, timeoutMs);
			if (!chunk) throw new Error('Socket closed before HTTP headers were complete.');
			buffer = concatBytes(buffer, chunk);
			if (buffer.byteLength > MAX_HEADER_BYTES) {
				throw new Error('HTTP response headers exceeded the proxy tunnel limit.');
			}
		}

		const headerEnd = indexOfHeaderEnd(buffer);
		const parsed = parseHeaderBytes(buffer.slice(0, headerEnd));
		const initialBody = buffer.slice(headerEnd + HEADER_END.length);
		if (method === 'HEAD' || parsed.status === 204 || parsed.status === 304) {
			return { ...parsed, body: new Uint8Array() };
		}

		const contentEncoding = parsed.headers.get('content-encoding');
		if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
			throw new Error(`HTTP proxy tunnel cannot decode ${contentEncoding} responses.`);
		}

		const transferEncoding = parsed.headers.get('transfer-encoding') || '';
		let body: Uint8Array<ArrayBuffer>;
		if (transferEncoding.toLowerCase().includes('chunked')) {
			body = await readChunkedBody(reader, initialBody, maxBodyBytes, timeoutMs);
			parsed.headers.delete('transfer-encoding');
			parsed.headers.set('content-length', String(body.byteLength));
		} else {
			body = await readPlainBody(reader, initialBody, parsed.headers, maxBodyBytes, timeoutMs);
		}
		parsed.headers.delete('connection');
		return { ...parsed, body };
	} finally {
		reader.releaseLock();
	}
}

function parseHeaderBytes(bytes: Uint8Array<ArrayBufferLike>): ParsedHttpResponse {
	const text = decoder.decode(bytes);
	const lines = text.split(/\r?\n/);
	const statusLine = lines.shift() || '';
	const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine);
	if (!statusMatch) throw new Error(`Invalid HTTP response status line: ${statusLine}`);
	const headers = new Headers();
	for (const line of lines) {
		const separator = line.indexOf(':');
		if (separator <= 0) continue;
		headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	return {
		status: Number(statusMatch[1]),
		statusText: statusMatch[2] || '',
		headers,
		body: new Uint8Array(),
	};
}

async function readPlainBody(
	reader: ReadableStreamDefaultReader,
	initialBody: Uint8Array<ArrayBufferLike>,
	headers: Headers,
	maxBodyBytes: number,
	timeoutMs: number
): Promise<Uint8Array<ArrayBuffer>> {
	const lengthHeader = headers.get('content-length');
	if (lengthHeader) {
		const expectedLength = Number(lengthHeader);
		if (!Number.isFinite(expectedLength) || expectedLength < 0) {
			throw new Error('Invalid content-length from proxied response.');
		}
		if (expectedLength > maxBodyBytes) {
			throw new Error('Proxied response exceeded the configured body limit.');
		}
		return readFixedLengthBody(reader, initialBody, expectedLength, timeoutMs);
	}

	let body = copyBytes(initialBody);
	while (true) {
		if (body.byteLength > maxBodyBytes) {
			throw new Error('Proxied response exceeded the configured body limit.');
		}
		const chunk = await readChunk(reader, timeoutMs);
		if (!chunk) return body;
		body = concatBytes(body, chunk);
	}
}

async function readFixedLengthBody(
	reader: ReadableStreamDefaultReader,
	initialBody: Uint8Array<ArrayBufferLike>,
	expectedLength: number,
	timeoutMs: number
): Promise<Uint8Array<ArrayBuffer>> {
	let body = initialBody;
	while (body.byteLength < expectedLength) {
		const chunk = await readChunk(reader, timeoutMs);
		if (!chunk) throw new Error('Socket closed before proxied response body was complete.');
		body = concatBytes(body, chunk);
	}
	return body.slice(0, expectedLength);
}

async function readChunkedBody(
	reader: ReadableStreamDefaultReader,
	initialBody: Uint8Array<ArrayBufferLike>,
	maxBodyBytes: number,
	timeoutMs: number
): Promise<Uint8Array<ArrayBuffer>> {
	let buffer = initialBody;
	let offset = 0;
	let body: Uint8Array<ArrayBuffer> = new Uint8Array();

	while (true) {
		let lineEnd = indexOfCrlf(buffer, offset);
		while (lineEnd < 0) {
			buffer = concatBytes(buffer.slice(offset), await requireChunk(reader, timeoutMs));
			offset = 0;
			lineEnd = indexOfCrlf(buffer, offset);
		}

		const sizeLine = decoder.decode(buffer.slice(offset, lineEnd)).split(';')[0].trim();
		const chunkSize = Number.parseInt(sizeLine, 16);
		if (!Number.isFinite(chunkSize) || chunkSize < 0) {
			throw new Error('Invalid chunk size from proxied response.');
		}
		offset = lineEnd + 2;
		if (chunkSize === 0) return body;

		while (buffer.byteLength < offset + chunkSize + 2) {
			buffer = concatBytes(buffer, await requireChunk(reader, timeoutMs));
		}

		body = concatBytes(body, buffer.slice(offset, offset + chunkSize));
		if (body.byteLength > maxBodyBytes) {
			throw new Error('Proxied response exceeded the configured body limit.');
		}
		offset += chunkSize + 2;

		if (offset > 32 * 1024) {
			buffer = buffer.slice(offset);
			offset = 0;
		}
	}
}

async function requireChunk(reader: ReadableStreamDefaultReader, timeoutMs: number): Promise<Uint8Array<ArrayBuffer>> {
	const chunk = await readChunk(reader, timeoutMs);
	if (!chunk) throw new Error('Socket closed before proxied response body was complete.');
	return chunk;
}

async function readChunk(reader: ReadableStreamDefaultReader, timeoutMs: number): Promise<Uint8Array<ArrayBuffer> | null> {
	const result = await withTimeout(reader.read(), timeoutMs, 'Timed out reading from HTTP proxy tunnel.');
	return result.done ? null : copyBytes(result.value);
}

function copyBytes(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
	const copied = new Uint8Array(bytes.byteLength);
	copied.set(bytes);
	return copied;
}

function concatBytes(
	left: Uint8Array<ArrayBufferLike>,
	right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
	if (left.byteLength === 0) return copyBytes(right);
	if (right.byteLength === 0) return copyBytes(left);
	const combined = new Uint8Array(left.byteLength + right.byteLength);
	combined.set(left, 0);
	combined.set(right, left.byteLength);
	return combined;
}

function indexOfHeaderEnd(bytes: Uint8Array<ArrayBufferLike>): number {
	return indexOfSequence(bytes, encoder.encode(HEADER_END), 0);
}

function indexOfCrlf(bytes: Uint8Array<ArrayBufferLike>, start: number): number {
	return indexOfSequence(bytes, encoder.encode(CRLF), start);
}

function indexOfSequence(
	bytes: Uint8Array<ArrayBufferLike>,
	sequence: Uint8Array<ArrayBufferLike>,
	start: number
): number {
	for (let i = start; i <= bytes.byteLength - sequence.byteLength; i++) {
		let matched = true;
		for (let j = 0; j < sequence.byteLength; j++) {
			if (bytes[i + j] !== sequence[j]) {
				matched = false;
				break;
			}
		}
		if (matched) return i;
	}
	return -1;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
