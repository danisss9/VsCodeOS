// The HTML shell every webview in this extension is served from.
//
// One place that gets the CSP right: a per-load nonce for the script, styles and
// images restricted to the extension's own media directory, and nothing else
// allowed at all unless a caller opts into it.

import * as vscode from 'vscode';

export interface PageOptions {
    title: string;
    /** File name under media/dist, without the extension. */
    script: string;
    /** Extra CSP sources, e.g. frame-src for the embedded players. */
    csp?: Partial<Record<'img' | 'media' | 'frame' | 'connect' | 'font', string[]>>;
    /** Extra roots the page may load resources from, beyond media/. */
    extraLocalRoots?: vscode.Uri[];
    body?: string;
}

export function nonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return text;
}

export function mediaRoot(context: vscode.ExtensionContext): vscode.Uri {
    return vscode.Uri.joinPath(context.extensionUri, 'media');
}

export function render(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    options: PageOptions,
): string {
    const media = mediaRoot(context);
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dist', `${options.script}.js`));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'css', 'vscodeos.css'));
    const n = nonce();

    const source = (kind: keyof NonNullable<PageOptions['csp']>, base: string[]): string =>
        [...base, ...(options.csp?.[kind] ?? [])].join(' ');

    const csp = [
        `default-src 'none'`,
        `img-src ${source('img', [webview.cspSource, 'data:'])}`,
        `media-src ${source('media', [webview.cspSource, 'data:', 'blob:'])}`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${source('font', [webview.cspSource])}`,
        `script-src 'nonce-${n}'`,
        `connect-src ${source('connect', [webview.cspSource])}`,
        ...(options.csp?.frame ? [`frame-src ${options.csp.frame.join(' ')}`] : []),
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>${escapeHtml(options.title)}</title>
</head>
<body class="vscodeos">
${options.body ?? '<div id="root"></div>'}
<script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** The options every webview here wants: scripts on, media/ readable. */
export function webviewOptions(context: vscode.ExtensionContext, extraRoots: vscode.Uri[] = []): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [mediaRoot(context), ...extraRoots],
    };
}
