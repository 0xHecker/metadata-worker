/* Ambient type augmentation for Cloudflare Workers bindings */

declare namespace Cloudflare {
	interface Env {
		KV: KVNamespace;
		R2: R2Bucket;
		METADATA_QUEUE?: Queue<unknown>;
		METADATA_DOMAIN_THROTTLE?: DurableObjectNamespace;
		IMPORT_MEDIA_TOKEN?: string;
		ALLOW_UNAUTH_IMPORT_MEDIA?: string;
		METADATA_POLICY_JSON?: string;
		PROXY_FALLBACK_STATUSES?: string;
		PROXY_ENABLED_PURPOSES?: string;
		PROXY_CHANNELS_JSON?: string;
		DATAIMPULSE_USERNAME?: string;
		DATAIMPULSE_PASSWORD?: string;
		DATAIMPULSE_PROXY_URL?: string;
	}
}
