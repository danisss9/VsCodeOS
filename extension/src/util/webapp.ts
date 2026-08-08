// Reading a web app manifest.
//
// Installing a PWA comes down to four facts: what it is called, what to open,
// what to draw and what to say about it. A site publishes those in a
// `<link rel="manifest">` document; the ones that do not still have a <title>
// and a favicon, which is enough to make a usable launcher entry.
//
// Everything here is pure - a string of HTML or a parsed JSON value in, plain
// data out - so the network half in src/sys/webapps.ts stays small and this
// half is testable.

export interface WebAppInfo {
    /** Slug derived from the URL; the id of the installed app and of its files. */
    id: string;
    name: string;
    description: string;
    /** Absolute URL the app opens at. */
    url: string;
    /** Absolute URL of the best icon the manifest offered, when there was one. */
    iconUrl?: string;
    themeColor?: string;
    /** False when the site published no manifest and this was built from the page. */
    fromManifest: boolean;
}

export interface ManifestIcon {
    src: string;
    sizes?: string;
    type?: string;
    purpose?: string;
}

/** Read one attribute out of a single HTML tag. */
function attribute(tag: string, name: string): string | undefined {
    const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
    if (!match) {
        return undefined;
    }
    return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

/** The five that matter in an attribute value; nothing here renders HTML. */
function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function tags(html: string, name: string): string[] {
    return html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];
}

/** The href of `<link rel="manifest">`, still relative to the page. */
export function manifestHref(html: string): string | undefined {
    for (const tag of tags(html, 'link')) {
        const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
        if (rel.includes('manifest')) {
            const href = attribute(tag, 'href');
            if (href) {
                return href;
            }
        }
    }
    return undefined;
}

/** The best `<link rel="icon">`, for sites with no manifest. */
export function faviconHref(html: string): string | undefined {
    let best: { href: string; score: number } | undefined;
    for (const tag of tags(html, 'link')) {
        const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
        const href = attribute(tag, 'href');
        if (!href || !rel.some((value) => value === 'icon' || value === 'apple-touch-icon')) {
            continue;
        }
        // A touch icon is a large square by definition, which is what a launcher
        // tile wants; a bare "icon" is often a 16px favicon.
        const score = (rel.includes('apple-touch-icon') ? 1000 : 0) + largestSize(attribute(tag, 'sizes'));
        if (!best || score > best.score) {
            best = { href, score };
        }
    }
    return best?.href;
}

export function documentTitle(html: string): string | undefined {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = match ? decodeEntities(match[1].replace(/\s+/g, ' ').trim()) : '';
    return title || undefined;
}

export function metaDescription(html: string): string | undefined {
    for (const tag of tags(html, 'meta')) {
        const name = (attribute(tag, 'name') ?? attribute(tag, 'property') ?? '').toLowerCase();
        if (name === 'description' || name === 'og:description') {
            const content = attribute(tag, 'content')?.replace(/\s+/g, ' ').trim();
            if (content) {
                return content;
            }
        }
    }
    return undefined;
}

/** "192x192 512x512" -> 512. `sizes="any"` counts as large, because SVG is. */
function largestSize(sizes: string | undefined): number {
    if (!sizes) {
        return 0;
    }
    if (/\bany\b/i.test(sizes)) {
        return 512;
    }
    let largest = 0;
    for (const token of sizes.split(/\s+/)) {
        const match = /^(\d+)x(\d+)$/i.exec(token);
        if (match) {
            largest = Math.max(largest, Math.min(Number(match[1]), Number(match[2])));
        }
    }
    return largest;
}

/**
 * The icon to install with. Anything marked `maskable` loses to a plain one -
 * a maskable icon is drawn assuming the platform will crop it to a circle, and
 * nothing here crops - and among the rest the one nearest 192px wins, because
 * that is roughly a launcher tile and upscaling a 32px favicon looks it.
 */
export function pickIcon(icons: ManifestIcon[], target = 192): ManifestIcon | undefined {
    const scored = icons
        .filter((icon) => typeof icon.src === 'string' && icon.src.length > 0)
        .map((icon) => {
            const purposes = (icon.purpose ?? 'any').toLowerCase().split(/\s+/);
            const maskableOnly = purposes.includes('maskable') && !purposes.includes('any');
            const monochrome = purposes.includes('monochrome');
            const size = largestSize(icon.sizes) || (/\.svg($|\?)/i.test(icon.src) ? 512 : 0);
            return { icon, maskableOnly, monochrome, distance: Math.abs((size || 64) - target) };
        })
        .filter((candidate) => !candidate.monochrome);

    if (scored.length === 0) {
        return undefined;
    }
    scored.sort((a, b) =>
        Number(a.maskableOnly) - Number(b.maskableOnly) || a.distance - b.distance);
    return scored[0].icon;
}

/**
 * A slug for the URL, used as the app's id, its icon file name and the name of
 * its desktop entry. Host first so apps from one site sort together, then the
 * path, so two apps on the same host do not collide.
 */
export function appIdFromUrl(url: string): string {
    let host = '';
    let pathname = '';
    try {
        const parsed = new URL(url);
        host = parsed.hostname.replace(/^www\./, '');
        pathname = parsed.pathname;
    } catch {
        host = url;
    }
    const slug = `${host}${pathname}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return (slug || 'web-app').slice(0, 64);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Turn a fetched manifest into the facts an installed app needs. */
export function webAppFromManifest(
    manifest: unknown,
    manifestUrl: string,
    pageUrl: string,
): WebAppInfo | undefined {
    if (typeof manifest !== 'object' || manifest === null) {
        return undefined;
    }
    const fields = manifest as Record<string, unknown>;
    const start = asString(fields.start_url) ?? pageUrl;
    const url = resolve(manifestUrl, start) ?? pageUrl;
    const icons = Array.isArray(fields.icons) ? (fields.icons as ManifestIcon[]) : [];
    const icon = pickIcon(icons);

    return {
        id: appIdFromUrl(url),
        name: asString(fields.name) ?? asString(fields.short_name) ?? hostOf(url),
        description: asString(fields.description) ?? hostOf(url),
        url,
        iconUrl: icon ? resolve(manifestUrl, icon.src) : undefined,
        themeColor: asString(fields.theme_color),
        fromManifest: true,
    };
}

/** Everything a site with no manifest still tells you about itself. */
export function webAppFromPage(html: string, pageUrl: string): WebAppInfo {
    const favicon = faviconHref(html);
    return {
        id: appIdFromUrl(pageUrl),
        name: documentTitle(html)?.split(/\s+[|·—–-]\s+/)[0].slice(0, 64) ?? hostOf(pageUrl),
        description: metaDescription(html)?.slice(0, 200) ?? hostOf(pageUrl),
        url: pageUrl,
        iconUrl: favicon ? resolve(pageUrl, favicon) : resolve(pageUrl, '/favicon.ico'),
        fromManifest: false,
    };
}

/**
 * What was typed into "Install from URL", as a URL, or undefined.
 *
 * Deliberately not `normaliseAddress` from util/url.ts: that turns anything
 * unrecognisable into a web search, which is right for an address bar and wrong
 * here - installing a search results page as an app is never what was meant. A
 * bare host still gets a scheme, because typing one is normal.
 */
export function normaliseSiteUrl(input: string): string | undefined {
    const text = input.trim();
    if (!text) {
        return undefined;
    }
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        ? text
        : /^localhost(:\d+)?([/?#].*)?$/i.test(text) || /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)
            ? `https://${text}`
            : undefined;
    if (!candidate) {
        return undefined;
    }
    try {
        const url = new URL(candidate);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Whether two addresses are the same installed app.
 *
 * Not id equality: an app is installed at its manifest's `start_url`, which is
 * routinely a deeper path than the address it was found at -
 * `https://docs.google.com` installs as `https://docs.google.com/document/u/0/`.
 * Comparing ids would leave the catalogue offering to install Google Docs
 * forever, and the Browser's Install button showing on a site already installed.
 * The origin is the thing that actually identifies the app.
 */
export function sameSite(a: string, b: string): boolean {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/** Absolute URL for a possibly-relative reference, or undefined if it is neither. */
export function resolve(base: string, reference: string): string | undefined {
    try {
        const url = new URL(reference, base);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}
