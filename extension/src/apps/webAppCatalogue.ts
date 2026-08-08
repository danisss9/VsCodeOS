// What the Marketplace has to offer.
//
// There is no registry of web apps to query - no index, no API, nothing with a
// stable shape - so a store that only worked by search would be a store with an
// empty front page. This list is compiled into the extension instead, which
// also means it is browsable on a machine that has never been online, which a
// freshly flashed one has not.
//
// Nothing here is downloaded from this file: it is a name, a sentence and a
// URL. Installing fetches the site's own manifest (sys/webapps.ts), so the app
// that lands is whatever the site says it is, not whatever was written here.
// If a site changes its address the worst case is one failed fetch with the
// reason shown.

export interface CatalogueEntry {
    id: string;
    name: string;
    description: string;
    url: string;
    category: string;
    keywords?: string[];
}

export const CATEGORIES = [
    'Installed',
    'Productivity',
    'Development',
    'Media',
    'Social',
    'Utilities',
] as const;

export const CATALOGUE: CatalogueEntry[] = [
    // ------------------------------------------------------------ productivity
    {
        id: 'google-docs',
        name: 'Google Docs',
        description: 'Write documents in the browser',
        url: 'https://docs.google.com',
        category: 'Productivity',
        keywords: ['word', 'writing', 'office'],
    },
    {
        id: 'google-sheets',
        name: 'Google Sheets',
        description: 'Spreadsheets in the browser',
        url: 'https://sheets.google.com',
        category: 'Productivity',
        keywords: ['excel', 'spreadsheet', 'office'],
    },
    {
        id: 'outlook',
        name: 'Outlook',
        description: 'Microsoft mail and calendar',
        url: 'https://outlook.live.com',
        category: 'Productivity',
        keywords: ['email', 'mail', 'hotmail', 'microsoft'],
    },
    {
        id: 'proton-mail',
        name: 'Proton Mail',
        description: 'Encrypted mail',
        url: 'https://mail.proton.me',
        category: 'Productivity',
        keywords: ['email', 'privacy', 'encrypted'],
    },
    {
        id: 'notion',
        name: 'Notion',
        description: 'Notes, documents and databases',
        url: 'https://www.notion.so',
        category: 'Productivity',
        keywords: ['notes', 'wiki', 'docs'],
    },
    {
        id: 'todoist',
        name: 'Todoist',
        description: 'Tasks and projects',
        url: 'https://app.todoist.com',
        category: 'Productivity',
        keywords: ['tasks', 'todo', 'gtd'],
    },
    {
        id: 'trello',
        name: 'Trello',
        description: 'Boards, lists and cards',
        url: 'https://trello.com',
        category: 'Productivity',
        keywords: ['kanban', 'boards', 'project'],
    },
    {
        id: 'proton-calendar',
        name: 'Proton Calendar',
        description: 'Encrypted calendar',
        url: 'https://calendar.proton.me',
        category: 'Productivity',
        keywords: ['calendar', 'schedule', 'privacy'],
    },

    // ------------------------------------------------------------- development
    {
        id: 'github',
        name: 'GitHub',
        description: 'Repositories, issues and pull requests',
        url: 'https://github.com',
        category: 'Development',
        keywords: ['git', 'code', 'repository'],
    },
    {
        id: 'gitlab',
        name: 'GitLab',
        description: 'Repositories and CI',
        url: 'https://gitlab.com',
        category: 'Development',
        keywords: ['git', 'code', 'ci'],
    },
    {
        id: 'vscode-dev',
        name: 'VS Code for the Web',
        description: 'The editor, in a browser tab',
        url: 'https://vscode.dev',
        category: 'Development',
        keywords: ['editor', 'code', 'web'],
    },
    {
        id: 'stackblitz',
        name: 'StackBlitz',
        description: 'Full-stack projects that run in the browser',
        url: 'https://stackblitz.com',
        category: 'Development',
        keywords: ['ide', 'sandbox', 'node'],
    },
    {
        id: 'codepen',
        name: 'CodePen',
        description: 'Front-end snippets and demos',
        url: 'https://codepen.io',
        category: 'Development',
        keywords: ['html', 'css', 'javascript', 'sandbox'],
    },
    {
        id: 'devdocs',
        name: 'DevDocs',
        description: 'API documentation for everything, offline-capable',
        url: 'https://devdocs.io',
        category: 'Development',
        keywords: ['docs', 'reference', 'api', 'manual'],
    },
    {
        id: 'regex101',
        name: 'regex101',
        description: 'Build and explain regular expressions',
        url: 'https://regex101.com',
        category: 'Development',
        keywords: ['regex', 'pattern', 'test'],
    },

    // -------------------------------------------------------------------- media
    {
        id: 'youtube',
        name: 'YouTube',
        description: 'Video',
        url: 'https://www.youtube.com',
        category: 'Media',
        keywords: ['video', 'watch', 'streaming'],
    },
    {
        id: 'youtube-music',
        name: 'YouTube Music',
        description: 'Streaming music',
        url: 'https://music.youtube.com',
        category: 'Media',
        keywords: ['music', 'streaming', 'songs'],
    },
    {
        id: 'spotify',
        name: 'Spotify',
        description: 'Streaming music. Needs a real browser window: VS Code’s Electron ships no Widevine',
        url: 'https://open.spotify.com',
        category: 'Media',
        keywords: ['music', 'streaming', 'podcasts'],
    },
    {
        id: 'soundcloud',
        name: 'SoundCloud',
        description: 'Independent music and mixes',
        url: 'https://soundcloud.com',
        category: 'Media',
        keywords: ['music', 'streaming', 'dj'],
    },
    {
        id: 'photopea',
        name: 'Photopea',
        description: 'A full image editor that opens PSD files',
        url: 'https://www.photopea.com',
        category: 'Media',
        keywords: ['photoshop', 'image', 'editor', 'psd'],
    },
    {
        id: 'excalidraw',
        name: 'Excalidraw',
        description: 'Hand-drawn-looking diagrams',
        url: 'https://excalidraw.com',
        category: 'Media',
        keywords: ['draw', 'diagram', 'whiteboard', 'sketch'],
    },
    {
        id: 'tldraw',
        name: 'tldraw',
        description: 'A very good whiteboard',
        url: 'https://www.tldraw.com',
        category: 'Media',
        keywords: ['draw', 'whiteboard', 'diagram'],
    },

    // ------------------------------------------------------------------- social
    {
        id: 'element',
        name: 'Element',
        description: 'Matrix chat',
        url: 'https://app.element.io',
        category: 'Social',
        keywords: ['chat', 'matrix', 'messaging'],
    },
    {
        id: 'discord',
        name: 'Discord',
        description: 'Voice and text chat',
        url: 'https://discord.com/app',
        category: 'Social',
        keywords: ['chat', 'voice', 'gaming'],
    },
    {
        id: 'telegram',
        name: 'Telegram',
        description: 'Messaging',
        url: 'https://web.telegram.org',
        category: 'Social',
        keywords: ['chat', 'messaging', 'sms'],
    },
    {
        id: 'whatsapp',
        name: 'WhatsApp',
        description: 'Messaging, paired with a phone',
        url: 'https://web.whatsapp.com',
        category: 'Social',
        keywords: ['chat', 'messaging', 'sms'],
    },
    {
        id: 'mastodon',
        name: 'Mastodon',
        description: 'The federated timeline',
        url: 'https://mastodon.social',
        category: 'Social',
        keywords: ['fediverse', 'microblog', 'social'],
    },

    // ---------------------------------------------------------------- utilities
    {
        id: 'openstreetmap',
        name: 'OpenStreetMap',
        description: 'Maps built by the people who use them',
        url: 'https://www.openstreetmap.org',
        category: 'Utilities',
        keywords: ['map', 'navigation', 'directions'],
    },
    {
        id: 'wikipedia',
        name: 'Wikipedia',
        description: 'The encyclopedia',
        url: 'https://en.m.wikipedia.org',
        category: 'Utilities',
        keywords: ['reference', 'encyclopedia', 'search'],
    },
    {
        id: 'archwiki',
        name: 'Arch Wiki',
        description: 'The documentation this machine runs on',
        url: 'https://wiki.archlinux.org',
        category: 'Utilities',
        keywords: ['arch', 'linux', 'docs', 'help'],
    },
    {
        id: 'squoosh',
        name: 'Squoosh',
        description: 'Compress images without leaving the machine',
        url: 'https://squoosh.app',
        category: 'Utilities',
        keywords: ['image', 'compress', 'optimise', 'resize'],
    },
    {
        id: 'internet-radio',
        name: 'Radio Garden',
        description: 'Live radio from anywhere on the globe',
        url: 'https://radio.garden',
        category: 'Utilities',
        keywords: ['radio', 'music', 'streaming'],
    },
];
