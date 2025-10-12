/* Ambient type augmentation for Cloudflare Workers bindings */

export interface Env {
	KV: KVNamespace;
	R2: R2Bucket;
	R2_PUBLIC_BASE?: string;
}
