import type { MetadataDomainThrottle } from './metadata-domain-throttle';
import {
	getMetadataPolicy,
	resolveMetadataTargetPolicy,
	type MetadataJobSource,
	type MetadataQueueMode,
} from './metadata-policy';

export type { MetadataQueueMode } from './metadata-policy';

export type MetadataQueueMessage = {
	version: 1;
	kind: 'metadata';
	mode: MetadataQueueMode;
	url: string;
	baseRequestUrl: string;
	refreshImage: boolean;
	requestedAt: number;
	dedupeKey: string;
	clientKey: string;
	jobId: string;
	source: MetadataJobSource;
	priority: number;
	bucket: string;
	pollAfterSeconds: number;
};

type QueueMetadataOptions = {
	baseRequestUrl: string;
	mode: MetadataQueueMode;
	refreshImage: boolean;
	clientKey: string;
	jobId: string;
	source: MetadataJobSource;
};

export type EnqueueMetadataResult = {
	queued: string[];
	skipped: string[];
	jobId: string;
	clientKey: string;
	retryAfterSeconds: number;
};

type MetadataProcessor = (message: MetadataQueueMessage) => Promise<void>;

function getQueue(env: Env): Queue<MetadataQueueMessage> | null {
	const queue = (env as unknown as Record<string, unknown>).METADATA_QUEUE;
	return queue && typeof queue === 'object' ? (queue as Queue<MetadataQueueMessage>) : null;
}

function getKv(env: Env): KVNamespace {
	if (!env.KV) throw new Error('KV binding is not configured.');
	return env.KV;
}

function getThrottle(env: Env): DurableObjectNamespace<MetadataDomainThrottle> | null {
	const throttle = (env as unknown as Record<string, unknown>).METADATA_DOMAIN_THROTTLE;
	return throttle && typeof throttle === 'object' ? (throttle as DurableObjectNamespace<MetadataDomainThrottle>) : null;
}

function isMetadataQueueMessage(value: unknown): value is MetadataQueueMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as Record<string, unknown>;
	return (
		message.version === 1 &&
		message.kind === 'metadata' &&
		(message.mode === 'hydrate' || message.mode === 'refresh') &&
		typeof message.url === 'string' &&
		typeof message.baseRequestUrl === 'string' &&
		typeof message.refreshImage === 'boolean' &&
		typeof message.requestedAt === 'number' &&
		typeof message.dedupeKey === 'string' &&
		typeof message.clientKey === 'string' &&
		typeof message.jobId === 'string' &&
		(message.source === 'api' || message.source === 'extension' || message.source === 'system') &&
		typeof message.priority === 'number' &&
		typeof message.bucket === 'string' &&
		typeof message.pollAfterSeconds === 'number'
	);
}

async function sha256(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', encoded);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function buildDedupeKey(url: string, mode: MetadataQueueMode, refreshImage: boolean): Promise<string> {
	const hash = await sha256(`${mode}:${url}:${refreshImage ? 'img' : 'meta'}`);
	return `metadata:v1:${hash}`;
}

function lockKey(dedupeKey: string): string {
	return `q:lock:${dedupeKey}`;
}

export async function enqueueMetadataJobs(
	env: Env,
	urls: string[],
	options: QueueMetadataOptions
): Promise<EnqueueMetadataResult> {
	const queue = getQueue(env);
	if (!queue) {
		throw new Error('METADATA_QUEUE binding is not configured.');
	}

	const policy = getMetadataPolicy(env);
	const kv = getKv(env);
	const messages: MessageSendRequest<MetadataQueueMessage>[] = [];
	const queued: string[] = [];
	const skipped: string[] = [];
	let retryAfterSeconds = policy.defaultPollAfterSeconds;

	for (const url of urls) {
		const targetPolicy = resolveMetadataTargetPolicy(env, url, options.mode);
		retryAfterSeconds = Math.max(retryAfterSeconds, targetPolicy.pollAfterSeconds);
		const dedupeKey = await buildDedupeKey(url, options.mode, options.refreshImage);
		const existing = await kv.get(lockKey(dedupeKey));
		if (existing) {
			skipped.push(url);
			continue;
		}

		await kv.put(lockKey(dedupeKey), String(Date.now()), {
			expirationTtl: policy.queue.lockTtlSeconds,
		});
		messages.push({
			body: {
				version: 1,
				kind: 'metadata',
				mode: options.mode,
				url,
				baseRequestUrl: options.baseRequestUrl,
				refreshImage: options.refreshImage,
				requestedAt: Date.now(),
				dedupeKey,
				clientKey: options.clientKey,
				jobId: options.jobId,
				source: options.source,
				priority: targetPolicy.priority,
				bucket: targetPolicy.bucket,
				pollAfterSeconds: targetPolicy.pollAfterSeconds,
			},
		});
		queued.push(url);
	}

	if (messages.length > 0) {
		await queue.sendBatch(messages);
	}

	return { queued, skipped, jobId: options.jobId, clientKey: options.clientKey, retryAfterSeconds };
}

function retryDelayFromError(env: Env, error: unknown): number {
	if (error && typeof error === 'object') {
		const retryAfterSeconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
		if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
			return Math.ceil(retryAfterSeconds);
		}
	}
	return getMetadataPolicy(env).queue.retryFallbackSeconds;
}

function shouldRetryError(error: unknown): boolean {
	if (error && typeof error === 'object') {
		return (error as { retryable?: unknown }).retryable === true;
	}
	return false;
}

export async function processMetadataQueue(
	batch: MessageBatch<MetadataQueueMessage>,
	env: Env,
	processMetadata: MetadataProcessor
): Promise<void> {
	const kv = getKv(env);

	for (const message of batch.messages) {
		if (!isMetadataQueueMessage(message.body)) {
			console.warn('Dropping invalid metadata queue message:', message.id);
			message.ack();
			continue;
		}

		// The lease is the worker-wide guardrail: it keeps many queue consumers from
		// stampeding one origin while still letting unrelated domains run quickly.
		const lease = await acquireDomainLease(env, message.body);
		if (!lease.granted) {
			message.retry({ delaySeconds: lease.retryAfterSeconds });
			continue;
		}

		try {
			if (lease.delayMs > 0) await sleep(lease.delayMs);
			await processMetadata(message.body);
			await kv.delete(lockKey(message.body.dedupeKey));
			message.ack();
		} catch (error) {
			console.warn('Metadata queue message failed:', message.body.url, error);
			if (shouldRetryError(error)) {
				message.retry({ delaySeconds: retryDelayFromError(env, error) });
				continue;
			}

			await kv.delete(lockKey(message.body.dedupeKey));
			message.ack();
		} finally {
			await releaseDomainLease(env, lease);
		}
	}
}

type AcquiredDomainLease = {
	granted: boolean;
	leaseId?: string;
	bucket: string;
	delayMs: number;
	retryAfterSeconds: number;
};

async function acquireDomainLease(env: Env, message: MetadataQueueMessage): Promise<AcquiredDomainLease> {
	const throttle = getThrottle(env);
	const targetPolicy = resolveMetadataTargetPolicy(env, message.url, message.mode);
	if (!throttle) {
		return { granted: true, bucket: targetPolicy.bucket, delayMs: 0, retryAfterSeconds: 1 };
	}

	const stub = throttle.get(throttle.idFromName(targetPolicy.bucket));
	const grant = await stub.acquire(targetPolicy.bucket, targetPolicy.throttle);
	return {
		granted: grant.granted,
		leaseId: grant.leaseId,
		bucket: targetPolicy.bucket,
		delayMs: grant.delayMs,
		retryAfterSeconds: grant.retryAfterSeconds,
	};
}

async function releaseDomainLease(env: Env, lease: AcquiredDomainLease): Promise<void> {
	if (!lease.leaseId) return;
	const throttle = getThrottle(env);
	if (!throttle) return;
	const stub = throttle.get(throttle.idFromName(lease.bucket));
	await stub.release(lease.leaseId);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
