// System and process statistics, read straight out of /proc and /sys.
//
// Deliberately not `ps`/`top`: those cost a process spawn per sample, and their
// output formats are a moving target. Reading /proc gives exact numbers, lets us
// compute CPU% from our own deltas, and costs nothing when the view is hidden.

import { promises as fs, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';

export interface ProcessInfo {
    pid: number;
    ppid: number;
    name: string;
    command: string;
    user: string;
    state: string;
    /** Percent of ONE core, top-style: 200 means two cores saturated. */
    cpu: number;
    /** Resident set size, bytes. */
    memory: number;
    /** Share of MemTotal, percent. */
    memoryPercent: number;
    threads: number;
    /** Seconds since the process started. */
    elapsed: number;
}

export interface MemoryInfo {
    total: number;
    available: number;
    used: number;
    free: number;
    cached: number;
    swapTotal: number;
    swapUsed: number;
}

export interface SystemInfo {
    cpu: {
        /** Aggregate load over the last sample, percent of all cores. */
        usage: number;
        /** Per-core usage, percent. */
        cores: number[];
        model: string;
        count: number;
        temperature?: number;
    };
    memory: MemoryInfo;
    load: [number, number, number];
    uptime: number;
    hostname: string;
    processCount: number;
}

interface CpuTimes {
    idle: number;
    total: number;
}

const PROC = '/proc';

/** Page size in bytes, derived once rather than assumed: /proc reports RSS in pages. */
const pageSize = (() => {
    try {
        const stat = readFileSync(`${PROC}/self/stat`, 'utf8');
        const rssPages = Number(fieldsAfterComm(stat)[21]);
        const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`${PROC}/self/status`, 'utf8'));
        if (match && rssPages > 0) {
            const derived = (Number(match[1]) * 1024) / rssPages;
            // Only trust a sane power of two; a racing allocation can skew it.
            if ([4096, 8192, 16384, 65536].includes(derived)) {
                return derived;
            }
        }
    } catch {
        /* fall through */
    }
    return 4096;
})();

/**
 * `/proc/<pid>/stat` is `pid (comm) state ppid …`, and comm may contain spaces
 * and parentheses, so it can only be split from the LAST ')'. The returned array
 * is 0-indexed at field 3 (state), i.e. field N of the man page is index N-3.
 */
function fieldsAfterComm(stat: string): string[] {
    const end = stat.lastIndexOf(')');
    return stat.slice(end + 2).split(' ');
}

function commOf(stat: string): string {
    const start = stat.indexOf('(');
    const end = stat.lastIndexOf(')');
    return start >= 0 && end > start ? stat.slice(start + 1, end) : '';
}

let userNames: Map<number, string> | undefined;

function userName(uid: number): string {
    if (!userNames) {
        userNames = new Map();
        try {
            for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
                const parts = line.split(':');
                if (parts.length >= 3) {
                    userNames.set(Number(parts[2]), parts[0]);
                }
            }
        } catch {
            /* an image without /etc/passwd is not a thing, but do not die over it */
        }
    }
    return userNames.get(uid) ?? String(uid);
}

async function readCpuTimes(): Promise<{ total: CpuTimes; cores: CpuTimes[] }> {
    const text = await fs.readFile(`${PROC}/stat`, 'utf8');
    let total: CpuTimes = { idle: 0, total: 0 };
    const cores: CpuTimes[] = [];
    for (const line of text.split('\n')) {
        if (!line.startsWith('cpu')) {
            break;
        }
        const parts = line.split(/\s+/);
        const values = parts.slice(1).map(Number).filter((n) => Number.isFinite(n));
        // user nice system idle iowait irq softirq steal guest guest_nice
        const idle = (values[3] ?? 0) + (values[4] ?? 0);
        const sum = values.reduce((a, b) => a + b, 0);
        if (parts[0] === 'cpu') {
            total = { idle, total: sum };
        } else {
            cores.push({ idle, total: sum });
        }
    }
    return { total, cores };
}

function usageBetween(previous: CpuTimes | undefined, current: CpuTimes): number {
    if (!previous) {
        return 0;
    }
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    if (totalDelta <= 0) {
        return 0;
    }
    return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function clampPercent(value: number): number {
    return Math.max(0, Math.round(value * 10) / 10);
}

async function readMemory(): Promise<MemoryInfo> {
    const text = await fs.readFile(`${PROC}/meminfo`, 'utf8');
    const values = new Map<string, number>();
    for (const line of text.split('\n')) {
        const match = /^(\w+):\s+(\d+) kB/.exec(line);
        if (match) {
            values.set(match[1], Number(match[2]) * 1024);
        }
    }
    const total = values.get('MemTotal') ?? 0;
    const available = values.get('MemAvailable') ?? values.get('MemFree') ?? 0;
    const swapTotal = values.get('SwapTotal') ?? 0;
    return {
        total,
        available,
        used: total - available,
        free: values.get('MemFree') ?? 0,
        cached: (values.get('Cached') ?? 0) + (values.get('Buffers') ?? 0),
        swapTotal,
        swapUsed: swapTotal - (values.get('SwapFree') ?? 0),
    };
}

function readCpuModel(): string {
    try {
        const text = readFileSync(`${PROC}/cpuinfo`, 'utf8');
        // x86 says "model name"; the Pi's aarch64 kernel says "Model" at the end.
        const match = /^(?:model name|Hardware|Model)\s*:\s*(.+)$/m.exec(text);
        if (match) {
            return match[1].trim();
        }
    } catch {
        /* fall through */
    }
    return os.cpus()[0]?.model?.trim() || 'CPU';
}

async function readTemperature(): Promise<number | undefined> {
    for (const zone of ['thermal_zone0', 'thermal_zone1']) {
        try {
            const raw = await fs.readFile(`/sys/class/thermal/${zone}/temp`, 'utf8');
            const value = Number(raw.trim());
            if (Number.isFinite(value) && value > 0) {
                // Kernels report milli-degrees; a few report degrees.
                return Math.round((value > 1000 ? value / 1000 : value) * 10) / 10;
            }
        } catch {
            /* no thermal zone on this board */
        }
    }
    return undefined;
}

/**
 * Sampler. Two calls are needed for meaningful CPU numbers, so the first sample
 * reports 0% everywhere - callers poll on an interval, so this is invisible.
 */
export class SystemSampler {
    private previousTotal: CpuTimes | undefined;
    private previousCores: CpuTimes[] = [];
    private previousProcesses = new Map<number, { jiffies: number; total: number }>();
    private readonly cpuModel = readCpuModel();
    private readonly cpuCount = os.cpus().length || 1;

    async sample(): Promise<{ system: SystemInfo; processes: ProcessInfo[] }> {
        const [{ total, cores }, memory, temperature] = await Promise.all([
            readCpuTimes(),
            readMemory(),
            readTemperature(),
        ]);
        const processes = await this.readProcesses(total, memory.total);

        const system: SystemInfo = {
            cpu: {
                usage: usageBetween(this.previousTotal, total),
                cores: cores.map((core, index) => usageBetween(this.previousCores[index], core)),
                model: this.cpuModel,
                count: this.cpuCount,
                temperature,
            },
            memory,
            load: os.loadavg() as [number, number, number],
            uptime: os.uptime(),
            hostname: os.hostname(),
            processCount: processes.length,
        };

        this.previousTotal = total;
        this.previousCores = cores;
        return { system, processes };
    }

    /** Forget the deltas, so the next sample starts clean after a pause. */
    reset(): void {
        this.previousTotal = undefined;
        this.previousCores = [];
        this.previousProcesses.clear();
    }

    private async readProcesses(cpuTotal: CpuTimes, memoryTotal: number): Promise<ProcessInfo[]> {
        const entries = await fs.readdir(PROC);
        const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number);
        const clockTicks = 100; // USER_HZ; constant on every Linux kernel we ship on.
        const bootTime = Date.now() / 1000 - os.uptime();
        const totalDelta = this.previousTotal ? cpuTotal.total - this.previousTotal.total : 0;

        const seen = new Map<number, { jiffies: number; total: number }>();
        const processes: ProcessInfo[] = [];

        await Promise.all(pids.map(async (pid) => {
            try {
                const [stat, cmdline] = await Promise.all([
                    fs.readFile(`${PROC}/${pid}/stat`, 'utf8'),
                    fs.readFile(`${PROC}/${pid}/cmdline`, 'utf8').catch(() => ''),
                ]);
                const fields = fieldsAfterComm(stat);
                const jiffies = Number(fields[11]) + Number(fields[12]);
                const rss = Number(fields[21]) * pageSize;
                const startTime = Number(fields[19]) / clockTicks;

                seen.set(pid, { jiffies, total: cpuTotal.total });

                let cpu = 0;
                const previous = this.previousProcesses.get(pid);
                if (previous && totalDelta > 0) {
                    // Percent of one core, so a fully busy thread reads 100.
                    cpu = clampPercent(((jiffies - previous.jiffies) / totalDelta) * this.cpuCount * 100);
                }

                const command = cmdline.replace(/\0/g, ' ').trim();
                const comm = commOf(stat);
                processes.push({
                    pid,
                    ppid: Number(fields[1]),
                    // comm is capped at 15 characters, so prefer argv[0]'s basename when we have it.
                    name: basename(cmdline.split('\0')[0]) || comm,
                    command: command || `[${comm}]`,
                    user: userName(uidOf(pid)),
                    state: fields[0] ?? '?',
                    cpu,
                    memory: rss,
                    memoryPercent: memoryTotal > 0 ? Math.round((rss / memoryTotal) * 1000) / 10 : 0,
                    threads: Number(fields[17]) || 1,
                    elapsed: Math.max(0, Date.now() / 1000 - (bootTime + startTime)),
                });
            } catch {
                // The process exited between readdir and read. Normal; skip it.
            }
        }));

        this.previousProcesses = seen;
        return processes;
    }
}

function uidOf(pid: number): number {
    try {
        return statSync(`${PROC}/${pid}`).uid;
    } catch {
        return 0;
    }
}

function basename(path: string): string {
    if (!path) {
        return '';
    }
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

/** SIGTERM, then SIGKILL if it is still there. Same-uid only; the caller handles EPERM. */
export async function endProcess(pid: number): Promise<{ ok: boolean; error?: string }> {
    try {
        process.kill(pid, 'SIGTERM');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
            return { ok: true };
        }
        return { ok: false, error: code === 'EPERM' ? 'permission denied' : String(error) };
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
        process.kill(pid, 0);
    } catch {
        return { ok: true }; // gone
    }
    try {
        process.kill(pid, 'SIGKILL');
        return { ok: true };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ESRCH' ? { ok: true } : { ok: false, error: code === 'EPERM' ? 'permission denied' : String(error) };
    }
}
