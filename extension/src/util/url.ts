// URLs built from input that is not ours.

/**
 * What an address bar does with whatever was typed into it: a URL is left
 * alone, something that looks like a host gets a scheme, and everything else is
 * a search. The distinction matters - "npm install" must not become
 * `https://npm install`, and "localhost:3000" must not become a web search.
 */
export function normaliseAddress(input: string, searchPrefix = 'https://duckduckgo.com/?q='): string {
    const text = input.trim();
    if (!text) {
        return 'about:blank';
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|file|view-source):/i.test(text)) {
        return text;
    }
    // localhost, with or without a port and path.
    if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) {
        return `http://${text}`;
    }
    // A dotted host, optionally with a port and a path, and no spaces anywhere.
    if (/^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) {
        return `https://${text}`;
    }
    return `${searchPrefix}${encodeURIComponent(text)}`;
}

/**
 * Microsoft's update endpoint for the current machine. The commit is asked for
 * as all zeroes, which is never the installed one, so the answer is always the
 * current build rather than "you are up to date".
 */
export function codeUpdateUrl(arch: string = process.arch): string {
    const target = arch === 'arm64' ? 'linux-arm64' : arch === 'arm' ? 'linux-armhf' : 'linux-x64';
    return `https://update.code.visualstudio.com/api/update/${target}/stable/${'0'.repeat(40)}`;
}
