// Turning a freedesktop notification into something VS Code can show.
//
// The bus hands over three things the editor has no idea what to do with: a
// body that may contain a small subset of HTML, an action list that is a flat
// array of alternating keys and labels, and a hints dictionary whose `urgency`
// decides whether this is an information message or a warning. All three are
// pure data manipulation, so they live here where they can be tested without a
// session bus.

export type Urgency = 'low' | 'normal' | 'critical';

/** The markup the spec allows in a body, none of which VS Code renders. */
const TAGS = /<\/?(?:b|i|u|a|img)(?:\s[^>]*)?\/?>/gi;

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
};

/**
 * Flatten a notification body to plain text.
 *
 * The Desktop Notifications spec allows `<b> <i> <u> <a> <img>` in a body and
 * says a server that does not render them should strip them - which is exactly
 * our case, because a VS Code message is plain text and would otherwise show
 * the angle brackets. Entities are unescaped afterwards so an escaped ampersand
 * does not survive as "&amp;".
 */
export function stripNotificationMarkup(body: string): string {
    return body
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(TAGS, '')
        .replace(/&[a-z]+;|&#\d+;/gi, (entity) => {
            const known = ENTITIES[entity.toLowerCase()];
            if (known !== undefined) {
                return known;
            }
            const numeric = /^&#(\d+);$/.exec(entity);
            return numeric ? String.fromCodePoint(Number(numeric[1])) : entity;
        })
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .trim();
}

export interface NotificationAction {
    key: string;
    label: string;
}

/**
 * `Notify`'s actions argument is a flat [key, label, key, label, …] array.
 *
 * The key "default" is the activation that happens when the notification body
 * itself is clicked, not a button, so it is dropped - there is nothing to click
 * in a VS Code message. A trailing key with no label is discarded rather than
 * shown with an empty caption.
 */
export function parseActions(actions: readonly string[]): NotificationAction[] {
    const parsed: NotificationAction[] = [];
    for (let i = 0; i + 1 < actions.length; i += 2) {
        const key = actions[i];
        const label = actions[i + 1];
        if (key === 'default' || !label) {
            continue;
        }
        parsed.push({ key, label });
    }
    return parsed;
}

/**
 * The `urgency` hint, which is a byte: 0 low, 1 normal, 2 critical.
 *
 * dbus-next unwraps variants for us, but the value still arrives as whatever
 * the sender chose to put in the variant, so anything unrecognised is normal.
 */
export function urgencyOf(hints: Record<string, unknown> | undefined): Urgency {
    const value = hints?.urgency;
    const level = typeof value === 'number' ? value : Number(value);
    if (level === 2) {
        return 'critical';
    }
    return level === 0 ? 'low' : 'normal';
}

/**
 * The single line a VS Code message shows.
 *
 * An em dash rather than a newline: `showInformationMessage` collapses
 * whitespace, so a two-line message would run together anyway and this at least
 * says where the summary stops.
 */
export function notificationText(summary: string, body: string): string {
    const head = stripNotificationMarkup(summary);
    const rest = stripNotificationMarkup(body).replace(/\s*\n\s*/g, ' ');
    if (!rest) {
        return head || 'Notification';
    }
    return head ? `${head} — ${rest}` : rest;
}
