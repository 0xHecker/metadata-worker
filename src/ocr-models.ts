export const OCR_MODEL_RATE_LIMIT = { windowSeconds: 60, maxRequests: 30 };

const OCR_MODEL_PATH_PREFIX = '/ocr-model/';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'Content-Type, X-VS-Source-Url, X-VS-File-Name, X-VS-Import-Token',
	'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const ocrModelCacheHeaders = {
	'Content-Type': 'application/x-tar',
	'Cache-Control': 'public, max-age=31536000, immutable',
};

type OcrModelId = 'a3f6c9d1-dec' | 'd8b2e7a4-rec';
type OcrModelName = 'PP-OCRv6_small_det_onnx' | 'PP-OCRv6_small_rec_onnx';

const ocrModels: Record<
	OcrModelId,
	{
		modelName: OcrModelName;
		fileName: string;
		repo: string;
		r2Key: string;
	}
> = {
	'a3f6c9d1-dec': {
		modelName: 'PP-OCRv6_small_det_onnx',
		fileName: 'PP-OCRv6_small_det_onnx.tar',
		repo: 'PaddlePaddle/PP-OCRv6_small_det_onnx',
		r2Key: 'ocr-models/v1/PP-OCRv6_small_det_onnx.tar',
	},
	'd8b2e7a4-rec': {
		modelName: 'PP-OCRv6_small_rec_onnx',
		fileName: 'PP-OCRv6_small_rec_onnx.tar',
		repo: 'PaddlePaddle/PP-OCRv6_small_rec_onnx',
		r2Key: 'ocr-models/v1/PP-OCRv6_small_rec_onnx.tar',
	},
};

const ocrModelAliases: Record<string, OcrModelId> = {
	a3f6c9d1: 'a3f6c9d1-dec',
	'a3f6c9d1-det': 'a3f6c9d1-dec',
	d8b2e7a4: 'd8b2e7a4-rec',
};

function appendCorsHeaders(headers: Headers) {
	for (const [key, value] of Object.entries(corsHeaders)) {
		headers.set(key, value);
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

function getR2(env: Env): R2Bucket {
	if (!env.R2) throw new Error('R2 binding is not configured.');
	return env.R2;
}

function appendFixedAscii(target: Uint8Array, offset: number, length: number, value: string) {
	for (let i = 0; i < length; i++) {
		target[offset + i] = i < value.length ? value.charCodeAt(i) & 0x7f : 0;
	}
}

function appendOctal(target: Uint8Array, offset: number, length: number, value: number) {
	const raw = Math.max(0, Math.floor(value)).toString(8);
	const padded = raw.padStart(Math.max(0, length - 1), '0').slice(-(length - 1));
	appendFixedAscii(target, offset, length, padded);
	target[offset + length - 1] = 0;
}

function buildTarHeader(name: string, size: number): Uint8Array {
	const header = new Uint8Array(512);
	appendFixedAscii(header, 0, 100, name);
	appendOctal(header, 100, 8, 0o644);
	appendOctal(header, 108, 8, 0);
	appendOctal(header, 116, 8, 0);
	appendOctal(header, 124, 12, size);
	appendOctal(header, 136, 12, Math.floor(Date.now() / 1000));
	for (let i = 148; i < 156; i++) header[i] = 32;
	header[156] = '0'.charCodeAt(0);
	appendFixedAscii(header, 257, 6, 'ustar');
	appendFixedAscii(header, 263, 2, '00');

	let checksum = 0;
	for (const byte of header) checksum += byte;
	const checksumRaw = checksum.toString(8).padStart(6, '0').slice(-6);
	appendFixedAscii(header, 148, 6, checksumRaw);
	header[154] = 0;
	header[155] = 32;
	return header;
}

function buildUncompressedTar(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 1024;
	for (const entry of entries) {
		const padding = (512 - (entry.data.byteLength % 512)) % 512;
		chunks.push(buildTarHeader(entry.name, entry.data.byteLength), entry.data);
		if (padding > 0) chunks.push(new Uint8Array(padding));
		total += 512 + entry.data.byteLength + padding;
	}
	chunks.push(new Uint8Array(1024));

	const tar = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		tar.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return tar;
}

async function fetchArrayBuffer(url: string, timeoutMs: number): Promise<ArrayBuffer> {
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'VibeSearch-OCR-Model-Cache/1.0',
			Accept: '*/*',
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return response.arrayBuffer();
}

async function buildOcrModelTar(modelId: OcrModelId): Promise<Uint8Array> {
	const model = ocrModels[modelId];
	const base = `https://huggingface.co/${model.repo}/resolve/main`;
	const [onnxBuffer, ymlBuffer] = await Promise.all([
		fetchArrayBuffer(`${base}/inference.onnx`, 60_000),
		fetchArrayBuffer(`${base}/inference.yml`, 20_000),
	]);
	return buildUncompressedTar([
		{ name: 'inference.onnx', data: new Uint8Array(onnxBuffer) },
		{ name: 'inference.yml', data: new Uint8Array(ymlBuffer) },
	]);
}

export function resolveOcrModelId(pathname: string): OcrModelId | null {
	if (!pathname.startsWith(OCR_MODEL_PATH_PREFIX)) return null;
	const fileName = decodeURIComponent(pathname.slice(OCR_MODEL_PATH_PREFIX.length)).replace(/\/+$/, '');
	if (fileName in ocrModels) return fileName as OcrModelId;
	if (fileName in ocrModelAliases) return ocrModelAliases[fileName];
	for (const [id, model] of Object.entries(ocrModels) as Array<[OcrModelId, (typeof ocrModels)[OcrModelId]]>) {
		if (model.fileName === fileName || model.modelName === fileName.replace(/\.tar$/, '')) {
			return id;
		}
	}
	return null;
}

export async function handleOcrModel(request: Request, env: Env, modelId: OcrModelId): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return jsonResponse({ error: 'Method not allowed.' }, { status: 405 });
	}

	const model = ocrModels[modelId];
	const headers = new Headers(ocrModelCacheHeaders);
	appendCorsHeaders(headers);

	const r2 = getR2(env);
	const cached = await r2.get(model.r2Key);
	if (cached) {
		cached.writeHttpMetadata(headers);
		return new Response(request.method === 'HEAD' ? null : cached.body, { headers });
	}

	const tar = await buildOcrModelTar(modelId);
	await r2.put(model.r2Key, tar, {
		httpMetadata: { contentType: 'application/x-tar' },
		customMetadata: {
			model: modelId,
			source: model.repo,
			cachedAt: new Date().toISOString(),
		},
	});

	return new Response(request.method === 'HEAD' ? null : tar, { headers });
}
