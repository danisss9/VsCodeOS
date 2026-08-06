// Paint: brush, eraser, shapes, fill, text, undo/redo, open and save PNG.

import { clear, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage } from '../../src/webview/protocol';

type Tool = 'brush' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'fill' | 'text' | 'picker';

const COLORS = [
    '#000000', '#7f7f7f', '#c3c3c3', '#ffffff',
    '#ed1c24', '#ff7f27', '#fff200', '#22b14c',
    '#00a2e8', '#3f48cc', '#a349a4', '#b97a57',
    '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d',
];

const WIDTH = 1000;
const HEIGHT = 640;

let tool: Tool = 'brush';
let color = '#000000';
let lineWidth = 4;
let drawing = false;
let startX = 0;
let startY = 0;
/** Canvas contents before the in-progress shape, so a drag can be previewed. */
let snapshot: ImageData | undefined;

const undoStack: string[] = [];
const redoStack: string[] = [];

const canvas = h('canvas', { id: 'canvas' }) as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;
const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
context.fillStyle = '#ffffff';
context.fillRect(0, 0, WIDTH, HEIGHT);
context.lineCap = 'round';
context.lineJoin = 'round';

const toolsPane = h('div', { class: 'paint-tools' });
const swatchesPane = h('div', { class: 'swatches' });
const widthLabel = h('span', { class: 'slider-value' }, '4');

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        h('button', {
            class: 'button', on: { click: () => post({ type: 'openImage' }) },
        }, h('span', { html: icon('open', 15) }), 'Open'),
        h('button', {
            class: 'button primary',
            on: { click: () => post({ type: 'savePng', dataUrl: canvas.toDataURL('image/png') }) },
        }, h('span', { html: icon('save', 15) }), 'Save PNG'),
        h('button', { class: 'button', on: { click: undo } }, h('span', { html: icon('undo', 15) }), 'Undo'),
        h('button', { class: 'button', on: { click: redo } }, h('span', { html: icon('redo', 15) }), 'Redo'),
        h('button', {
            class: 'button',
            on: {
                click: () => {
                    if (confirm('Clear the canvas?')) {
                        pushUndo();
                        context.fillStyle = '#ffffff';
                        context.fillRect(0, 0, WIDTH, HEIGHT);
                    }
                },
            },
        }, h('span', { html: icon('trash', 15) }), 'Clear'),
        h('span', { class: 'spacer' }),
        h('div', { class: 'field' },
            h('label', {}, 'Size'),
            h('input', {
                type: 'range', min: 1, max: 60, value: lineWidth,
                style: { width: '110px' },
                on: {
                    input: (event: Event) => {
                        lineWidth = Number((event.target as HTMLInputElement).value);
                        widthLabel.textContent = String(lineWidth);
                    },
                },
            }),
            widthLabel,
        ),
        swatchesPane,
        h('input', {
            type: 'color', value: color,
            title: 'Custom colour',
            on: { input: (event: Event) => setColor((event.target as HTMLInputElement).value) },
        }),
    ),
    h('div', { class: 'body' }, h('div', { class: 'paint-wrap' },
        toolsPane,
        h('div', { class: 'canvas-area' }, canvas),
    )),
));

const TOOLS: [Tool, string, string][] = [
    ['brush', 'editor', 'Brush'],
    ['eraser', 'close', 'Eraser'],
    ['line', 'chevronRight', 'Line'],
    ['rect', 'stop', 'Rectangle'],
    ['ellipse', 'globe', 'Ellipse'],
    ['fill', 'disk', 'Fill'],
    ['text', 'file', 'Text'],
    ['picker', 'search', 'Pick colour'],
];

function renderTools(): void {
    clear(toolsPane);
    for (const [name, glyph, label] of TOOLS) {
        toolsPane.append(h('button', {
            class: `tool${tool === name ? ' active' : ''}`,
            title: label,
            html: icon(glyph, 18),
            on: { click: () => { tool = name; renderTools(); } },
        }));
    }
}

function renderSwatches(): void {
    clear(swatchesPane);
    for (const value of COLORS) {
        swatchesPane.append(h('button', {
            class: `swatch${value === color ? ' active' : ''}`,
            style: { background: value },
            title: value,
            on: { click: () => setColor(value) },
        }));
    }
}

function setColor(value: string): void {
    color = value;
    renderSwatches();
}

// ------------------------------------------------------------------- undo

function pushUndo(): void {
    undoStack.push(canvas.toDataURL());
    if (undoStack.length > 25) {
        undoStack.shift();
    }
    redoStack.length = 0;
}

function restore(dataUrl: string): void {
    const image = new Image();
    image.onload = () => {
        context.clearRect(0, 0, WIDTH, HEIGHT);
        context.drawImage(image, 0, 0);
    };
    image.src = dataUrl;
}

function undo(): void {
    const previous = undoStack.pop();
    if (!previous) {
        return;
    }
    redoStack.push(canvas.toDataURL());
    restore(previous);
}

function redo(): void {
    const next = redoStack.pop();
    if (!next) {
        return;
    }
    undoStack.push(canvas.toDataURL());
    restore(next);
}

// ---------------------------------------------------------------- drawing

/** Canvas is scaled to fit the viewport, so pointer coords need unscaling. */
function pointOf(event: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((event.clientX - rect.left) / rect.width) * WIDTH,
        y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
    };
}

canvas.addEventListener('pointerdown', (event) => {
    const { x, y } = pointOf(event);
    canvas.setPointerCapture(event.pointerId);

    if (tool === 'picker') {
        const data = context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        setColor(`#${[data[0], data[1], data[2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
        return;
    }

    if (tool === 'text') {
        const text = prompt('Text to draw');
        if (text) {
            pushUndo();
            context.fillStyle = color;
            context.font = `${Math.max(12, lineWidth * 5)}px var(--vscode-font-family, sans-serif)`;
            context.fillText(text, x, y);
        }
        return;
    }

    if (tool === 'fill') {
        pushUndo();
        floodFill(Math.floor(x), Math.floor(y), color);
        return;
    }

    pushUndo();
    drawing = true;
    startX = x;
    startY = y;
    snapshot = context.getImageData(0, 0, WIDTH, HEIGHT);

    if (tool === 'brush' || tool === 'eraser') {
        context.beginPath();
        context.moveTo(x, y);
    }
});

canvas.addEventListener('pointermove', (event) => {
    if (!drawing) {
        return;
    }
    const { x, y } = pointOf(event);
    context.lineWidth = lineWidth;
    context.strokeStyle = tool === 'eraser' ? '#ffffff' : color;

    if (tool === 'brush' || tool === 'eraser') {
        context.lineTo(x, y);
        context.stroke();
        return;
    }

    // Shape tools redraw from the snapshot so the preview follows the pointer.
    if (snapshot) {
        context.putImageData(snapshot, 0, 0);
    }
    context.beginPath();
    if (tool === 'line') {
        context.moveTo(startX, startY);
        context.lineTo(x, y);
    } else if (tool === 'rect') {
        context.rect(startX, startY, x - startX, y - startY);
    } else {
        context.ellipse(
            (startX + x) / 2, (startY + y) / 2,
            Math.abs(x - startX) / 2, Math.abs(y - startY) / 2,
            0, 0, Math.PI * 2,
        );
    }
    context.stroke();
});

const finish = (): void => {
    drawing = false;
    snapshot = undefined;
    context.closePath();
};
canvas.addEventListener('pointerup', finish);
canvas.addEventListener('pointercancel', finish);
canvas.addEventListener('pointerleave', () => {
    if (drawing && (tool === 'brush' || tool === 'eraser')) {
        finish();
    }
});

/** Scanline flood fill; the recursive version blows the stack on a full canvas. */
function floodFill(x: number, y: number, fill: string): void {
    const image = context.getImageData(0, 0, WIDTH, HEIGHT);
    const data = image.data;
    const target = offset(x, y);
    const start = [data[target], data[target + 1], data[target + 2], data[target + 3]];

    const parsed = fill.replace('#', '');
    const replacement = [
        parseInt(parsed.slice(0, 2), 16),
        parseInt(parsed.slice(2, 4), 16),
        parseInt(parsed.slice(4, 6), 16),
        255,
    ];
    if (start.every((value, index) => value === replacement[index])) {
        return;
    }

    const matches = (index: number): boolean =>
        Math.abs(data[index] - start[0]) < 12
        && Math.abs(data[index + 1] - start[1]) < 12
        && Math.abs(data[index + 2] - start[2]) < 12
        && Math.abs(data[index + 3] - start[3]) < 12;

    const stack: [number, number][] = [[x, y]];
    while (stack.length) {
        const [px, py] = stack.pop() as [number, number];
        if (py < 0 || py >= HEIGHT) {
            continue;
        }
        let left = px;
        while (left >= 0 && matches(offset(left, py))) {
            left--;
        }
        left++;
        let spanAbove = false;
        let spanBelow = false;
        for (let cx = left; cx < WIDTH && matches(offset(cx, py)); cx++) {
            const index = offset(cx, py);
            data[index] = replacement[0];
            data[index + 1] = replacement[1];
            data[index + 2] = replacement[2];
            data[index + 3] = replacement[3];

            if (py > 0 && matches(offset(cx, py - 1)) !== spanAbove) {
                spanAbove = !spanAbove;
                if (spanAbove) {
                    stack.push([cx, py - 1]);
                }
            }
            if (py < HEIGHT - 1 && matches(offset(cx, py + 1)) !== spanBelow) {
                spanBelow = !spanBelow;
                if (spanBelow) {
                    stack.push([cx, py + 1]);
                }
            }
        }
    }
    context.putImageData(image, 0, 0);
}

function offset(x: number, y: number): number {
    return (y * WIDTH + x) * 4;
}

onMessage<HostMessage>((message) => {
    if (message.type !== 'image') {
        return;
    }
    const image = new Image();
    image.onload = () => {
        pushUndo();
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, WIDTH, HEIGHT);
        // Fit rather than stretch, so an opened photo keeps its aspect ratio.
        const scale = Math.min(WIDTH / image.width, HEIGHT / image.height, 1);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (WIDTH - width) / 2, (HEIGHT - height) / 2, width, height);
    };
    image.src = message.uri;
});

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        post({ type: 'savePng', dataUrl: canvas.toDataURL('image/png') });
    }
});

renderTools();
renderSwatches();
post({ type: 'ready' });
