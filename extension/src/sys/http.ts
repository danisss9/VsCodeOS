// The one place this shell reaches the network from.
//
// Installing a web app means fetching a page, a manifest and an icon, and that
// is the whole of it - there is no HTTP client dependency here, and adding one
// for three GETs would be the wrong trade in an extension that ships inside an
// ISO. `node:https` does the work; what this adds is the three things a raw
// request does not have and every caller needs: a timeout, a redirect limit and
// a hard cap on how many bytes an untrusted server can make us hold in memory.

import * as http from 'node:http';
import * as https from 'node:https';
import { log } from '../log';

export interface HttpResponse {
    ok: boolean;
    status: number;
    /** The URL the body actually came from, after redirects. */
    url: string;
    contentType: string;
    body: Buffer;
}

export interface GetOptions {
    /** Refuse a body larger than this, rather than buffering it. */
    maxBytes?: number;
    timeoutMs?: number;
    accept?: string;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) VSCodeOS/1.0 Safari/537.36';

/**
 * GET a URL, following redirects. Never throws: a DNS failure, a timeout and a
 * 404 all come back as `ok: false`, because every caller is either drawing a
 * dialog or reporting into a webview and would rather say why than crash.
 */
export async function get(url: string, options: GetOptions = {}): Promise<HttpResponse> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    let current = url;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        const response = await once(current, options, maxBytes);
        if (response.redirectTo) {
            current = response.redirectTo;
            continue;
        }
        return response.result;
    }

    return { ok: false, status: 0, url: current, contentType: '', body: Buffer.alloc(0) };
}

/** GET and parse as JSON, or undefined if either half failed. */
export async function getJson(url: string, options: GetOptions = {}): Promise<unknown> {
    const response = await get(url, { accept: 'application/manifest+json, application/json', ...options });
    if (!response.ok) {
        return undefined;
    }
    try {
        return JSON.parse(response.body.toString('utf8'));
    } catch (error) {
        log.debug(`not JSON: ${url} (${String(error)})`);
        return undefined;
    }
}

interface Attempt {
    result: HttpResponse;
    redirectTo?: string;
}

function once(url: string, options: GetOptions, maxBytes: number): Promise<Attempt> {
    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            resolve({ result: fail(url, 0) });
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            resolve({ result: fail(url, 0) });
            return;
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.get(
            parsed,
            {
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: options.accept ?? 'text/html,application/xhtml+xml,*/*',
                    'Accept-Language': 'en',
                },
                timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            },
            (response) => {
                const status = response.statusCode ?? 0;
                const location = response.headers.location;
                if (status >= 300 && status < 400 && location) {
                    response.resume();
                    let next: string;
                    try {
                        next = new URL(location, url).toString();
                    } catch {
                        resolve({ result: fail(url, status) });
                        return;
                    }
                    resolve({ result: fail(url, status), redirectTo: next });
                    return;
                }

                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        // Stop reading rather than buffer an unbounded body from
                        // a server we have no reason to trust.
                        request.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    resolve({
                        result: {
                            ok: status >= 200 && status < 300 && size <= maxBytes,
                            status,
                            url,
                            contentType: String(response.headers['content-type'] ?? ''),
                            body: Buffer.concat(chunks),
                        },
                    });
                });
                response.on('error', () => resolve({ result: fail(url, status) }));
            },
        );

        request.on('timeout', () => request.destroy());
        request.on('error', (error) => {
            log.debug(`GET ${url} failed: ${error.message}`);
            resolve({ result: fail(url, 0) });
        });
    });
}

function fail(url: string, status: number): HttpResponse {
    return { ok: false, status, url, contentType: '', body: Buffer.alloc(0) };
}
