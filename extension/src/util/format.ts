// Small formatters shared by the tray, the task manager and the file explorer.

const TOKEN = /yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|ss|A|a/g;

/**
 * Deliberately not Intl: the clock format is a user setting, and people expect
 * to type "HH:mm" there, not a locale tag. Locale-aware output is still what the
 * tooltips and the calendar use.
 */
function apply(date: Date, pattern: string): string {
    const hours12 = date.getHours() % 12 || 12;
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

    return pattern.replace(TOKEN, (token) => {
        switch (token) {
            case 'yyyy': return String(date.getFullYear());
            case 'yy': return pad(date.getFullYear() % 100);
            case 'MMMM': return date.toLocaleDateString(undefined, { month: 'long' });
            case 'MMM': return date.toLocaleDateString(undefined, { month: 'short' });
            case 'MM': return pad(date.getMonth() + 1);
            case 'M': return String(date.getMonth() + 1);
            case 'dd': return pad(date.getDate());
            case 'd': return String(date.getDate());
            case 'EEEE': return date.toLocaleDateString(undefined, { weekday: 'long' });
            case 'EEE': return date.toLocaleDateString(undefined, { weekday: 'short' });
            case 'HH': return pad(date.getHours());
            case 'H': return String(date.getHours());
            case 'hh': return pad(hours12);
            case 'h': return String(hours12);
            case 'mm': return pad(date.getMinutes());
            case 'ss': return pad(date.getSeconds());
            case 'A': return date.getHours() < 12 ? 'AM' : 'PM';
            case 'a': return date.getHours() < 12 ? 'am' : 'pm';
            default: return token;
        }
    });
}

export function formatTime(date: Date, pattern: string): string {
    return apply(date, pattern || 'HH:mm');
}

export function formatDate(date: Date, pattern: string): string {
    return apply(date, pattern || 'dd/MM/yyyy');
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

/** "3d 04:12" - the elapsed column in the task manager. */
export function formatElapsed(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const rest = formatDuration(seconds % 86400);
    return days > 0 ? `${days}d ${rest}` : rest;
}

/** Expand a leading ~ against $HOME, which is how the directory settings are written. */
export function expandHome(path: string, home: string): string {
    if (path === '~') {
        return home;
    }
    return path.startsWith('~/') ? `${home}/${path.slice(2)}` : path;
}
