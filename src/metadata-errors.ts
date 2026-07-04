export class MetadataFetchError extends Error {
	status?: number;
	retryable: boolean;
	retryAfterSeconds?: number;
	metadataFetchVia?: 'direct' | 'proxy';
	metadataProxyChannel?: string;

	constructor(
		message: string,
		options: {
			status?: number;
			retryable?: boolean;
			retryAfterSeconds?: number;
			metadataFetchVia?: 'direct' | 'proxy';
			metadataProxyChannel?: string;
		} = {}
	) {
		super(message);
		this.name = 'MetadataFetchError';
		this.status = options.status;
		this.retryable = options.retryable === true;
		this.retryAfterSeconds = options.retryAfterSeconds;
		this.metadataFetchVia = options.metadataFetchVia;
		this.metadataProxyChannel = options.metadataProxyChannel;
	}
}
