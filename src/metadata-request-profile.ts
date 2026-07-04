const HTML_DOCUMENT_ACCEPT =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';

export type MetadataHtmlRequestHeadersOptions = {
	userAgent: string;
	refresh?: boolean;
	referer?: string;
};

export function buildMetadataHtmlRequestHeaders(options: MetadataHtmlRequestHeadersOptions): Headers {
	const headers = new Headers({
		'User-Agent': options.userAgent,
		Accept: HTML_DOCUMENT_ACCEPT,
		'Accept-Language': 'en-US,en;q=0.9',
		'Upgrade-Insecure-Requests': '1',
		'Sec-Fetch-Dest': 'document',
		'Sec-Fetch-Mode': 'navigate',
		'Sec-Fetch-Site': options.referer ? 'cross-site' : 'none',
		'Sec-Fetch-User': '?1',
	});

	if (options.referer) {
		headers.set('Referer', options.referer);
	}
	if (options.refresh) {
		headers.set('Cache-Control', 'no-cache');
		headers.set('Pragma', 'no-cache');
	}

	addClientHints(headers, options.userAgent);
	return headers;
}

function addClientHints(headers: Headers, userAgent: string): void {
	const chrome = /(?:Chrome|Chromium|CriOS)\/(\d+)/.exec(userAgent);
	if (!chrome) return;

	const majorVersion = chrome[1];
	headers.set('Sec-CH-UA', `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not.A/Brand";v="99"`);
	headers.set('Sec-CH-UA-Mobile', /Mobile|Android|iPhone/.test(userAgent) ? '?1' : '?0');
	headers.set('Sec-CH-UA-Platform', `"${inferPlatform(userAgent)}"`);
}

function inferPlatform(userAgent: string): string {
	if (/Android/i.test(userAgent)) return 'Android';
	if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
	if (/Windows/i.test(userAgent)) return 'Windows';
	if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macOS';
	if (/Linux/i.test(userAgent)) return 'Linux';
	return 'Unknown';
}
