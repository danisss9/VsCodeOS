// Shared webview helpers.
//
// No framework: every one of these pages is small, and a bundled UI library
// would cost more than the whole extension does. `h()` is the entire abstraction.

export interface VsCodeApi {
    postMessage(message: unknown): void;
    getState<T>(): T | undefined;
    setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export function post(message: unknown): void {
    vscode.postMessage(message);
}

export type Child = Node | string | null | undefined | false;

export interface Attributes {
    class?: string;
    id?: string;
    title?: string;
    type?: string;
    value?: string | number;
    placeholder?: string;
    min?: string | number;
    max?: string | number;
    step?: string | number;
    src?: string;
    href?: string;
    alt?: string;
    controls?: boolean;
    disabled?: boolean;
    checked?: boolean;
    hidden?: boolean;
    role?: string;
    tabIndex?: number;
    dataset?: Record<string, string>;
    style?: Partial<CSSStyleDeclaration>;
    html?: string;
    on?: Partial<Record<keyof GlobalEventHandlersEventMap, (event: never) => void>>;
    [key: `aria-${string}`]: string | undefined;
}

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Attributes = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key === 'on') {
            for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) {
                element.addEventListener(event, handler);
            }
        } else if (key === 'dataset') {
            Object.assign(element.dataset, value);
        } else if (key === 'style') {
            Object.assign(element.style, value);
        } else if (key === 'html') {
            // Only ever used with icon markup this file owns, never with user text.
            element.innerHTML = String(value);
        } else if (key === 'class') {
            element.className = String(value);
        } else if (key === 'tabIndex') {
            element.tabIndex = Number(value);
        } else if (key === 'disabled' || key === 'checked' || key === 'hidden' || key === 'controls') {
            (element as unknown as Record<string, boolean>)[key] = Boolean(value);
        } else if (key === 'value') {
            (element as unknown as Record<string, string>).value = String(value);
        } else {
            element.setAttribute(key, String(value));
        }
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        element.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return element;
}

export function clear(node: HTMLElement): HTMLElement {
    node.replaceChildren();
    return node;
}

/** Like `node.append`, but skips the nulls conditional children produce. */
export function append(node: HTMLElement, ...children: Child[]): HTMLElement {
    for (const child of children) {
        if (child !== null && child !== undefined && child !== false) {
            node.append(child);
        }
    }
    return node;
}

export function root(): HTMLElement {
    const existing = document.getElementById('root');
    if (existing) {
        return existing;
    }
    const created = h('div', { id: 'root' });
    document.body.append(created);
    return created;
}

export function onMessage<T>(handler: (message: T) => void): void {
    window.addEventListener('message', (event: MessageEvent<T>) => handler(event.data));
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** exponent;
    return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '0:00';
    }
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Coalesce rapid slider input into one message per frame. */
export function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): T {
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    return ((...args: Parameters<T>) => {
        const now = Date.now();
        const wait = ms - (now - last);
        if (wait <= 0) {
            last = now;
            fn(...(args as never[]));
        } else if (!pending) {
            pending = setTimeout(() => {
                pending = undefined;
                last = Date.now();
                fn(...(args as never[]));
            }, wait);
        }
    }) as T;
}
