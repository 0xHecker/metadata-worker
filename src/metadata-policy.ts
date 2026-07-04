export type MetadataQueueMode = 'hydrate' | 'refresh';
export type MetadataJobSource = 'api' | 'extension' | 'system';

export type MetadataThrottleRule = {
	intervalMs: number;
	maxConcurrent: number;
	leaseTtlMs: number;
	maxDelayMs: number;
};

export type MetadataDomainPolicy = {
	match: string | string[];
	bucket?: string;
	throttle?: Partial<MetadataThrottleRule>;
	pollAfterSeconds?: number;
	priority?: number;
	userAgent?: string;
	rewriteImagesToR2?: boolean;
	proxyMode?: 'fallback' | 'required';
	rejectMetadataTitleIncludes?: string[];
};

export type MetadataPolicy = {
	inlineLimit: number;
	maxUrlsPerRequest: number;
	defaultPollAfterSeconds: number;
	defaultPriority: Record<MetadataQueueMode, number>;
	queue: {
		lockTtlSeconds: number;
		retryFallbackSeconds: number;
	};
	throttle: {
		default: MetadataThrottleRule;
		domains: MetadataDomainPolicy[];
	};
	proxyBudget: {
		maxRequestsPerMinute?: number;
		maxRequestsPerDay?: number;
		maxFailuresBeforeCooldown?: number;
	};
};

export type ResolvedMetadataTargetPolicy = {
	url: string;
	hostname: string;
	bucket: string;
	throttle: MetadataThrottleRule;
	pollAfterSeconds: number;
	priority: number;
	userAgent?: string;
	rewriteImagesToR2: boolean;
	proxyMode: 'fallback' | 'required';
	rejectMetadataTitleIncludes: string[];
};

type PartialMetadataPolicy = Partial<
	Omit<MetadataPolicy, 'queue' | 'throttle' | 'defaultPriority' | 'proxyBudget'>
> & {
	defaultPriority?: Partial<Record<MetadataQueueMode, number>>;
	queue?: Partial<MetadataPolicy['queue']>;
	throttle?: {
		default?: Partial<MetadataThrottleRule>;
		domains?: MetadataDomainPolicy[];
	};
	proxyBudget?: Partial<MetadataPolicy['proxyBudget']>;
};

const DEFAULT_THROTTLE: MetadataThrottleRule = {
	intervalMs: 300,
	maxConcurrent: 4,
	leaseTtlMs: 30_000,
	maxDelayMs: 30_000,
};

const DEFAULT_POLICY: MetadataPolicy = {
	inlineLimit: 2,
	maxUrlsPerRequest: 100,
	defaultPollAfterSeconds: 30,
	defaultPriority: {
		hydrate: 5,
		refresh: 3,
	},
	queue: {
		lockTtlSeconds: 20 * 60,
		retryFallbackSeconds: 60,
	},
	throttle: {
		default: DEFAULT_THROTTLE,
		domains: [],
	},
	proxyBudget: {},
};

function getEnvString(env: Env, key: string): string {
	const value = (env as unknown as Record<string, unknown>)[key];
	return typeof value === 'string' ? value.trim() : '';
}

export function getMetadataPolicy(env: Env): MetadataPolicy {
	const raw = getEnvString(env, 'METADATA_POLICY_JSON');
	if (!raw) return DEFAULT_POLICY;
	try {
		return mergePolicy(JSON.parse(raw) as PartialMetadataPolicy);
	} catch (error) {
		console.warn('Invalid METADATA_POLICY_JSON; using default metadata policy.', error);
		return DEFAULT_POLICY;
	}
}

export function resolveMetadataTargetPolicy(
	env: Env,
	targetUrl: string,
	mode: MetadataQueueMode
): ResolvedMetadataTargetPolicy {
	const policy = getMetadataPolicy(env);
	const hostname = normalizedHostname(targetUrl);
	const domainPolicy = findDomainPolicy(policy, hostname);
	const bucket = normalizeBucket(domainPolicy?.bucket || hostname || 'invalid-url');
	const throttle = mergeThrottle(policy.throttle.default, domainPolicy?.throttle || {});
	const pollAfterSeconds = positiveInteger(domainPolicy?.pollAfterSeconds) || policy.defaultPollAfterSeconds;
	const priority = positiveInteger(domainPolicy?.priority) || policy.defaultPriority[mode];
	return {
		url: targetUrl,
		hostname,
		bucket,
		throttle,
		pollAfterSeconds,
		priority,
		userAgent: cleanString(domainPolicy?.userAgent),
		rewriteImagesToR2: domainPolicy?.rewriteImagesToR2 === true,
		proxyMode: domainPolicy?.proxyMode === 'required' ? 'required' : 'fallback',
		rejectMetadataTitleIncludes: cleanStringArray(domainPolicy?.rejectMetadataTitleIncludes),
	};
}

function mergePolicy(config: PartialMetadataPolicy): MetadataPolicy {
	return {
		inlineLimit: positiveInteger(config.inlineLimit) || DEFAULT_POLICY.inlineLimit,
		maxUrlsPerRequest: positiveInteger(config.maxUrlsPerRequest) || DEFAULT_POLICY.maxUrlsPerRequest,
		defaultPollAfterSeconds:
			positiveInteger(config.defaultPollAfterSeconds) || DEFAULT_POLICY.defaultPollAfterSeconds,
		defaultPriority: {
			hydrate: positiveInteger(config.defaultPriority?.hydrate) || DEFAULT_POLICY.defaultPriority.hydrate,
			refresh: positiveInteger(config.defaultPriority?.refresh) || DEFAULT_POLICY.defaultPriority.refresh,
		},
		queue: {
			lockTtlSeconds: positiveInteger(config.queue?.lockTtlSeconds) || DEFAULT_POLICY.queue.lockTtlSeconds,
			retryFallbackSeconds:
				positiveInteger(config.queue?.retryFallbackSeconds) || DEFAULT_POLICY.queue.retryFallbackSeconds,
		},
		throttle: {
			default: mergeThrottle(DEFAULT_POLICY.throttle.default, config.throttle?.default || {}),
			domains: Array.isArray(config.throttle?.domains) ? config.throttle.domains.filter(isDomainPolicy) : [],
		},
		proxyBudget: {
			maxRequestsPerMinute: positiveInteger(config.proxyBudget?.maxRequestsPerMinute) || undefined,
			maxRequestsPerDay: positiveInteger(config.proxyBudget?.maxRequestsPerDay) || undefined,
			maxFailuresBeforeCooldown:
				positiveInteger(config.proxyBudget?.maxFailuresBeforeCooldown) || undefined,
		},
	};
}

function mergeThrottle(base: MetadataThrottleRule, override: Partial<MetadataThrottleRule>): MetadataThrottleRule {
	return {
		intervalMs: positiveInteger(override.intervalMs) || base.intervalMs,
		maxConcurrent: positiveInteger(override.maxConcurrent) || base.maxConcurrent,
		leaseTtlMs: positiveInteger(override.leaseTtlMs) || base.leaseTtlMs,
		maxDelayMs: positiveInteger(override.maxDelayMs) || base.maxDelayMs,
	};
}

function findDomainPolicy(policy: MetadataPolicy, hostname: string): MetadataDomainPolicy | null {
	for (const domainPolicy of policy.throttle.domains) {
		const matches = Array.isArray(domainPolicy.match) ? domainPolicy.match : [domainPolicy.match];
		if (matches.some((match) => domainMatches(hostname, match))) {
			return domainPolicy;
		}
	}
	return null;
}

function isDomainPolicy(value: unknown): value is MetadataDomainPolicy {
	if (!value || typeof value !== 'object') return false;
	const policy = value as Record<string, unknown>;
	return typeof policy.match === 'string' || Array.isArray(policy.match);
}

function normalizedHostname(targetUrl: string): string {
	try {
		return new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return 'invalid-url';
	}
}

function normalizeBucket(bucket: string): string {
	return bucket.trim().toLowerCase() || 'default';
}

function domainMatches(hostname: string, rawMatch: string): boolean {
	const match = rawMatch.trim().toLowerCase();
	if (!match) return false;
	if (match.startsWith('*.')) {
		const suffix = match.slice(2);
		return hostname.endsWith(`.${suffix}`);
	}
	return hostname === match || hostname.endsWith(`.${match}`);
}

function positiveInteger(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return Math.ceil(value);
}

function cleanString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean)
		.slice(0, 20);
}
