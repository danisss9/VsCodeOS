// Task Manager front-end: system meters plus a sortable process table.

import { append, clear, formatBytes, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage, ProcessInfo, SystemInfo } from '../../src/webview/protocol';

type Column = 'name' | 'pid' | 'user' | 'cpu' | 'memory' | 'threads' | 'elapsed';

let sortColumn: Column = 'cpu';
let sortDescending = true;
let filter = '';
let selected: number | undefined;
let paused = false;
let system: SystemInfo | undefined;
let processes: ProcessInfo[] = [];

const meters = h('div', { class: 'meters' });
const tableBody = h('tbody');
const status = h('div', { class: 'status' });
const filterInput = h('input', {
    type: 'search',
    placeholder: 'Filter processes',
    style: { flex: '1', minWidth: '120px' },
    on: {
        input: (event: Event) => {
            filter = (event.target as HTMLInputElement).value.toLowerCase();
            renderTable();
        },
    },
});

const pauseButton = h('button', {
    class: 'button',
    title: 'Pause sampling',
    on: {
        click: () => {
            paused = !paused;
            post({ type: 'pause', paused });
            pauseButton.replaceChildren(
                h('span', { html: icon(paused ? 'play' : 'pause', 15) }),
                paused ? 'Resume' : 'Pause',
            );
        },
    },
}, h('span', { html: icon('pause', 15) }), 'Pause');

const endButton = h('button', {
    class: 'button primary',
    disabled: true,
    on: {
        click: () => {
            const target = processes.find((p) => p.pid === selected);
            if (target) {
                post({ type: 'endTask', pid: target.pid, name: target.name });
            }
        },
    },
}, h('span', { html: icon('close', 15) }), 'End task');

const table = h('table', { class: 'processes' },
    h('thead', {}, h('tr', {},
        header('Name', 'name'),
        header('PID', 'pid', true),
        header('User', 'user'),
        header('CPU', 'cpu', true),
        header('Memory', 'memory', true),
        header('Threads', 'threads', true),
        header('Uptime', 'elapsed', true),
    )),
    tableBody,
);

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' }, filterInput, pauseButton, endButton),
    h('div', { class: 'body' }, meters, table),
    status,
));

function header(label: string, column: Column, numeric = false): HTMLElement {
    return h('th', {
        class: numeric ? 'num' : '',
        dataset: { column },
        on: {
            click: () => {
                if (sortColumn === column) {
                    sortDescending = !sortDescending;
                } else {
                    sortColumn = column;
                    // Numbers are most useful biggest-first, names A-Z.
                    sortDescending = numeric;
                }
                renderTable();
            },
        },
    }, label);
}

onMessage<HostMessage>((message) => {
    if (message.type === 'tasks') {
        system = message.system;
        processes = message.processes;
        renderMeters();
        renderTable();
    } else if (message.type === 'taskError') {
        clear(status).append(h('span', { class: 'hot' }, message.message));
    }
});

post({ type: 'ready' });

function renderMeters(): void {
    if (!system) {
        return;
    }
    const memoryPercent = system.memory.total > 0
        ? Math.round((system.memory.used / system.memory.total) * 100)
        : 0;

    append(clear(meters),
        h('div', { class: 'meter' },
            h('div', { class: 'meter-head' },
                h('span', { html: icon('cpu', 16) }),
                h('span', {}, 'CPU'),
                h('span', { class: 'meter-value' }, `${system.cpu.usage.toFixed(0)}%`),
            ),
            h('div', { class: `bar${system.cpu.usage > 90 ? ' warn' : ''}` },
                h('span', { style: { width: `${system.cpu.usage}%` } })),
            h('div', { class: 'cores' },
                ...system.cpu.cores.map((value) =>
                    h('span', { style: { height: `${Math.max(3, value)}%` }, title: `${value.toFixed(0)}%` })),
            ),
            h('div', { class: 'meter-sub' },
                `${system.cpu.model} · ${system.cpu.count} cores`
                + (system.cpu.temperature !== undefined ? ` · ${system.cpu.temperature}°C` : '')),
        ),
        h('div', { class: 'meter' },
            h('div', { class: 'meter-head' },
                h('span', { html: icon('memory', 16) }),
                h('span', {}, 'Memory'),
                h('span', { class: 'meter-value' }, `${memoryPercent}%`),
            ),
            h('div', { class: `bar${memoryPercent > 90 ? ' warn' : ''}` },
                h('span', { style: { width: `${memoryPercent}%` } })),
            h('div', { class: 'meter-sub' },
                `${formatBytes(system.memory.used)} of ${formatBytes(system.memory.total)} used · ${formatBytes(system.memory.cached)} cached`),
        ),
        system.memory.swapTotal > 0
            ? h('div', { class: 'meter' },
                h('div', { class: 'meter-head' },
                    h('span', { html: icon('disk', 16) }),
                    h('span', {}, 'Swap'),
                    h('span', { class: 'meter-value' },
                        `${Math.round((system.memory.swapUsed / system.memory.swapTotal) * 100)}%`),
                ),
                h('div', { class: 'bar' },
                    h('span', { style: { width: `${(system.memory.swapUsed / system.memory.swapTotal) * 100}%` } })),
                h('div', { class: 'meter-sub' },
                    `${formatBytes(system.memory.swapUsed)} of ${formatBytes(system.memory.swapTotal)}`),
            )
            : null,
        h('div', { class: 'meter' },
            h('div', { class: 'meter-head' },
                h('span', { html: icon('grid', 16) }),
                h('span', {}, 'System'),
                h('span', { class: 'meter-value' }, String(system.processCount)),
            ),
            h('div', { class: 'meter-sub' },
                `${system.hostname} · up ${uptime(system.uptime)}`),
            h('div', { class: 'meter-sub' },
                `Load ${system.load.map((l) => l.toFixed(2)).join('  ')}`),
        ),
    );

    append(clear(status),
        h('span', {}, `${processes.length} processes`),
        h('span', {}, paused ? 'Paused' : 'Live'),
    );
}

function renderTable(): void {
    const rows = processes
        .filter((p) => !filter
            || p.name.toLowerCase().includes(filter)
            || p.command.toLowerCase().includes(filter)
            || String(p.pid) === filter)
        .sort(compare)
        .slice(0, 400); // the table is for looking at, not for scrolling 900 rows

    clear(tableBody);
    for (const process of rows) {
        const row = h('tr', {
            class: process.pid === selected ? 'selected' : '',
            title: process.command,
            on: {
                click: () => {
                    selected = process.pid;
                    endButton.disabled = false;
                    renderTable();
                },
                dblclick: () => post({ type: 'endTask', pid: process.pid, name: process.name }),
            },
        },
        h('td', {}, process.name),
        h('td', { class: 'num' }, String(process.pid)),
        h('td', {}, process.user),
        h('td', { class: `num${process.cpu > 50 ? ' hot' : ''}` }, `${process.cpu.toFixed(1)}%`),
        h('td', { class: 'num' }, formatBytes(process.memory)),
        h('td', { class: 'num' }, String(process.threads)),
        h('td', { class: 'num' }, uptime(process.elapsed)),
        );
        tableBody.append(row);
    }

    if (rows.length === 0) {
        tableBody.append(h('tr', {}, h('td', { class: 'empty' }, 'No matching processes.')));
    }
}

function compare(a: ProcessInfo, b: ProcessInfo): number {
    const direction = sortDescending ? -1 : 1;
    switch (sortColumn) {
        case 'name': return direction * a.name.localeCompare(b.name);
        case 'user': return direction * a.user.localeCompare(b.user);
        case 'pid': return direction * (a.pid - b.pid);
        case 'memory': return direction * (a.memory - b.memory);
        case 'threads': return direction * (a.threads - b.threads);
        case 'elapsed': return direction * (a.elapsed - b.elapsed);
        default: return direction * (a.cpu - b.cpu) || b.memory - a.memory;
    }
}

function uptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${Math.floor(seconds % 60)}s`;
}
