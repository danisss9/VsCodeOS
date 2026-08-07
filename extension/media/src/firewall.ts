// The Firewall app's page.
//
// A master switch, the two default policies, the rule list, and a form for
// adding a rule. The log pane at the bottom shows what the helper actually ran,
// because "it did not work" is not a useful thing to tell someone about a
// firewall.

import { clear, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { FirewallPolicy, FirewallState, HostMessage } from '../../src/webview/protocol';

let state: FirewallState | undefined;

const body = h('div', { class: 'body firewall' });
const logEl = h('pre', { class: 'update-log', hidden: true });

const refreshButton = h('button', {
    class: 'button',
    on: { click: () => post({ type: 'firewallRefresh' }) },
}, h('span', { html: icon('refresh', 15) }), 'Refresh');

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        h('span', { html: icon('shield', 16) }),
        h('span', {}, 'Firewall'),
        h('span', { class: 'spacer' }),
        refreshButton,
    ),
    body,
));

onMessage<HostMessage>((message) => {
    if (message.type === 'firewall') {
        state = message.state;
        render();
        return;
    }
    if (message.type === 'firewallBusy') {
        if (state) {
            state.busy = message.busy;
            render();
        }
        return;
    }
    if (message.type === 'firewallLog') {
        logEl.hidden = false;
        logEl.append(document.createTextNode(message.chunk));
        const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
        if (atBottom) {
            logEl.scrollTop = logEl.scrollHeight;
        }
    }
});

post({ type: 'ready' });

function render(): void {
    clear(body);
    refreshButton.disabled = state?.busy ?? false;

    if (!state) {
        body.append(h('div', { class: 'empty' }, 'Reading the firewall…'));
        return;
    }
    if (!state.installed) {
        body.append(h('div', { class: 'empty' },
            'ufw is not installed. Install it with: sudo pacman -S ufw'));
        return;
    }
    if (!state.canElevate) {
        body.append(h('div', { class: 'empty' },
            'pkexec is not installed, so the firewall cannot be read or changed from here.'));
        return;
    }

    const status = state.status;
    const active = status?.active ?? false;

    body.append(masterSwitch(active));

    if (!status) {
        body.append(h('div', { class: 'error-banner' },
            'The firewall status could not be read. The log below may say why.'));
        body.append(logEl);
        return;
    }

    if (active && state.sshListening && !allowsSsh(status)) {
        body.append(h('div', { class: 'error-banner' },
            'This machine is accepting SSH connections but no rule allows them through. '
            + 'Anyone administering it over the network is already locked out.'));
    }

    body.append(policyGroup(status.incoming, status.outgoing));
    body.append(rulesGroup(status));
    body.append(addRuleGroup());
    body.append(advancedGroup(status));
    body.append(logEl);
}

function allowsSsh(status: NonNullable<FirewallState['status']>): boolean {
    return status.rules.some(
        (rule) => /^(22(\/tcp)?|OpenSSH)\b/i.test(rule.to) && rule.action.startsWith('ALLOW'),
    );
}

function masterSwitch(active: boolean): HTMLElement {
    return h('div', { class: 'setting-group firewall-master' },
        h('div', { class: 'setting-row' },
            h('div', { class: 'setting-label' },
                h('div', { class: 'pane-title' }, active ? 'Firewall is on' : 'Firewall is off'),
                h('div', { class: 'list-sub' }, active
                    ? 'Incoming connections are filtered by the rules below.'
                    : 'Nothing is filtered. Every port this machine listens on is reachable.'),
            ),
            h('div', { class: 'setting-control' },
                h('button', {
                    class: `button${active ? '' : ' primary'}`,
                    disabled: state?.busy ?? false,
                    on: { click: () => post({ type: 'firewallToggle', enabled: !active }) },
                }, active ? 'Turn off' : 'Turn on'),
            ),
        ),
    );
}

function policySelect(direction: 'incoming' | 'outgoing', current: FirewallPolicy | undefined): HTMLElement {
    const el = h('select', { class: 'setting-select' }) as HTMLSelectElement;
    const options: [FirewallPolicy, string][] = [
        ['allow', 'Allow'],
        ['deny', 'Deny (drop silently)'],
        ['reject', 'Reject (send a refusal)'],
    ];
    for (const [value, label] of options) {
        const option = h('option', { value }, label) as HTMLOptionElement;
        option.selected = value === current;
        el.append(option);
    }
    el.disabled = state?.busy ?? false;
    el.addEventListener('change', () =>
        post({ type: 'firewallPolicy', direction, policy: el.value as FirewallPolicy }));
    return el;
}

function policyGroup(incoming?: FirewallPolicy, outgoing?: FirewallPolicy): HTMLElement {
    return h('div', { class: 'setting-group' },
        h('div', { class: 'section-head' }, 'Default policy'),
        h('div', { class: 'setting-row' },
            h('div', { class: 'setting-label' },
                h('div', {}, 'Incoming'),
                h('div', { class: 'list-sub' }, 'What happens to a connection no rule matches.'),
            ),
            h('div', { class: 'setting-control' }, policySelect('incoming', incoming)),
        ),
        h('div', { class: 'setting-row' },
            h('div', { class: 'setting-label' },
                h('div', {}, 'Outgoing'),
                h('div', { class: 'list-sub' }, 'Denying this breaks most things; allow is the usual answer.'),
            ),
            h('div', { class: 'setting-control' }, policySelect('outgoing', outgoing)),
        ),
    );
}

function rulesGroup(status: NonNullable<FirewallState['status']>): HTMLElement {
    const group = h('div', { class: 'setting-group' },
        h('div', { class: 'section-head' }, `Rules (${status.rules.length})`),
    );

    if (status.rules.length === 0) {
        group.append(h('div', { class: 'empty' },
            'No rules. With a deny-incoming policy, nothing can reach this machine.'));
        return group;
    }

    const list = h('div', { class: 'list' });
    for (const rule of status.rules) {
        const allow = rule.action.startsWith('ALLOW');
        list.append(h('div', { class: 'list-row' },
            h('span', { html: icon(allow ? 'check' : 'close', 16) }),
            h('span', { class: 'list-main' },
                h('div', { class: 'list-name' }, rule.to),
                h('div', { class: 'list-sub' }, `${rule.action} · from ${rule.from}`),
            ),
            rule.v6 ? h('span', { class: 'update-badge' }, 'IPv6') : null,
            h('button', {
                class: 'icon-button',
                title: 'Delete this rule',
                html: icon('trash', 15),
                disabled: state?.busy ?? false,
                on: {
                    click: () => post({
                        type: 'firewallDelete',
                        number: rule.number,
                        label: `${rule.to} — ${rule.action} from ${rule.from}`,
                    }),
                },
            }),
        ));
    }
    group.append(list);
    return group;
}

const PRESETS: [string, string][] = [
    ['22/tcp', 'SSH'],
    ['80/tcp', 'HTTP'],
    ['443/tcp', 'HTTPS'],
];

function addRuleGroup(): HTMLElement {
    const spec = h('input', {
        class: 'app-search',
        type: 'text',
        placeholder: 'Port, range or profile — 22/tcp, 6000:6010/udp, OpenSSH',
    }) as HTMLInputElement;

    const action = h('select', { class: 'setting-select' }) as HTMLSelectElement;
    for (const [value, label] of [
        ['allow', 'Allow'],
        ['deny', 'Deny'],
        ['limit', 'Limit (rate-limited allow)'],
    ] as [string, string][]) {
        action.append(h('option', { value }, label));
    }

    const submit = (): void => {
        const value = spec.value.trim();
        if (!value) {
            return;
        }
        post({ type: 'firewallRule', action: action.value as 'allow' | 'deny' | 'limit', spec: value });
        spec.value = '';
    };

    spec.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
            submit();
        }
    });

    return h('div', { class: 'setting-group' },
        h('div', { class: 'section-head' }, 'Add a rule'),
        h('div', { class: 'firewall-add' },
            action,
            spec,
            h('button', {
                class: 'button primary',
                disabled: state?.busy ?? false,
                on: { click: submit },
            }, h('span', { html: icon('plus', 15) }), 'Add'),
        ),
        h('div', { class: 'firewall-presets' },
            h('span', { class: 'list-sub' }, 'Common:'),
            ...PRESETS.map(([value, label]) => h('button', {
                class: 'button',
                disabled: state?.busy ?? false,
                on: { click: () => post({ type: 'firewallRule', action: 'allow', spec: value }) },
            }, `Allow ${label}`)),
        ),
    );
}

function advancedGroup(status: NonNullable<FirewallState['status']>): HTMLElement {
    const loggingOn = (status.logging ?? '').startsWith('on');
    return h('div', { class: 'setting-group' },
        h('div', { class: 'section-head' }, 'Advanced'),
        h('div', { class: 'setting-row' },
            h('div', { class: 'setting-label' },
                h('div', {}, 'Logging'),
                h('div', { class: 'list-sub' },
                    status.logging ? `Currently ${status.logging}.` : 'Blocked packets are recorded in the journal.'),
            ),
            h('div', { class: 'setting-control' },
                h('button', {
                    class: 'button',
                    disabled: state?.busy ?? false,
                    on: { click: () => post({ type: 'firewallLogging', enabled: !loggingOn }) },
                }, loggingOn ? 'Turn logging off' : 'Turn logging on'),
            ),
        ),
        h('div', { class: 'setting-row' },
            h('div', { class: 'setting-label' },
                h('div', {}, 'Reset'),
                h('div', { class: 'list-sub' }, 'Delete every rule and turn the firewall off.'),
            ),
            h('div', { class: 'setting-control' },
                h('button', {
                    class: 'button',
                    disabled: state?.busy ?? false,
                    on: { click: () => post({ type: 'firewallReset' }) },
                }, 'Reset firewall'),
            ),
        ),
    );
}
