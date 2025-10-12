/* Ambient type augmentation for Cloudflare Workers bindings */

declare namespace Cloudflare {
	interface Env {
		KV: KVNamespace;
		R2: R2Bucket;
		R2_PUBLIC_BASE?: string;
	}
}
