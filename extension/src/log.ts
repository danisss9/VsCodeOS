import * as vscode from 'vscode';

class Log {
    private channel: vscode.OutputChannel | undefined;

    attach(channel: vscode.OutputChannel): void {
        this.channel = channel;
    }

    info(message: string): void {
        this.write('info', message);
    }

    warn(message: string): void {
        this.write('warn', message);
    }

    error(message: string, error?: unknown): void {
        const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? '' : `: ${String(error)}`;
        this.write('error', `${message}${detail}`);
    }

    /** Command failures are routine here (a widget probing for a missing binary), so they stay quiet. */
    debug(message: string): void {
        this.write('debug', message);
    }

    private write(level: string, message: string): void {
        const stamp = new Date().toISOString().slice(11, 23);
        this.channel?.appendLine(`[${stamp}] ${level.padEnd(5)} ${message}`);
    }
}

export const log = new Log();
