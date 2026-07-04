import { DurableObject } from 'cloudflare:workers';
import type { MetadataThrottleRule } from './metadata-policy';

export type DomainThrottleGrant = {
	bucket: string;
	granted: boolean;
	leaseId?: string;
	delayMs: number;
	retryAfterSeconds: number;
	intervalMs: number;
	maxConcurrent: number;
	activeCount: number;
};

export class MetadataDomainThrottle extends DurableObject<Env> {
	private nextStartAt = 0;
	private readonly activeLeases = new Map<string, number>();

	acquire(bucket: string, throttle: MetadataThrottleRule): DomainThrottleGrant {
		const now = Date.now();
		this.cleanupExpiredLeases(now);

		// This object is deliberately protective rather than canonical: leases are
		// short-lived backpressure so a hot bucket slows itself without blocking the whole queue.
		if (this.activeLeases.size >= throttle.maxConcurrent) {
			const delayMs = this.nextLeaseDelayMs(now, throttle);
			return this.deniedGrant(bucket, throttle, delayMs);
		}

		const delayMs = Math.max(0, this.nextStartAt - now);
		if (delayMs > throttle.maxDelayMs) {
			return this.deniedGrant(bucket, throttle, delayMs);
		}

		const leaseId = crypto.randomUUID();
		const leaseExpiresAt = now + delayMs + throttle.leaseTtlMs;
		this.activeLeases.set(leaseId, leaseExpiresAt);
		this.nextStartAt = Math.max(now, this.nextStartAt) + throttle.intervalMs;

		return {
			bucket,
			granted: true,
			leaseId,
			delayMs,
			retryAfterSeconds: Math.max(1, Math.ceil(delayMs / 1000)),
			intervalMs: throttle.intervalMs,
			maxConcurrent: throttle.maxConcurrent,
			activeCount: this.activeLeases.size,
		};
	}

	release(leaseId: string): boolean {
		return this.activeLeases.delete(leaseId);
	}

	private deniedGrant(bucket: string, throttle: MetadataThrottleRule, delayMs: number): DomainThrottleGrant {
		const boundedDelayMs = Math.min(throttle.maxDelayMs, Math.max(throttle.intervalMs, delayMs));
		return {
			bucket,
			granted: false,
			delayMs: boundedDelayMs,
			retryAfterSeconds: Math.max(1, Math.ceil(boundedDelayMs / 1000)),
			intervalMs: throttle.intervalMs,
			maxConcurrent: throttle.maxConcurrent,
			activeCount: this.activeLeases.size,
		};
	}

	private nextLeaseDelayMs(now: number, throttle: MetadataThrottleRule): number {
		let earliestExpiry = Number.POSITIVE_INFINITY;
		for (const expiresAt of this.activeLeases.values()) {
			earliestExpiry = Math.min(earliestExpiry, expiresAt);
		}
		if (!Number.isFinite(earliestExpiry)) return throttle.intervalMs;
		return Math.max(throttle.intervalMs, earliestExpiry - now);
	}

	private cleanupExpiredLeases(now: number) {
		for (const [leaseId, expiresAt] of this.activeLeases.entries()) {
			if (expiresAt <= now) {
				this.activeLeases.delete(leaseId);
			}
		}
	}
}
