import { useEffect, useState } from 'react';

/**
 * How-to guides. Each guide answers one question with short steps, an
 * optional "do it now" action, and (for most) a screen-recorded video that
 * is hosted on the Native API server, so videos can be re-recorded without a
 * launcher update. The manifest overrides the built-in URLs when available.
 */

export const GUIDE_MEDIA_ROOT = 'https://api.nativelaunch.xyz/guides';
const MANIFEST_URL = `${GUIDE_MEDIA_ROOT}/manifest.json`;

export const GUIDE_CATEGORIES = [
  { id: 'start', label: 'Getting started' },
  { id: 'play', label: 'Instances & playing' },
  { id: 'content', label: 'Mods & content' },
  { id: 'account', label: 'Accounts & social' },
  { id: 'help', label: 'Fixes & settings' }
];

export const GUIDES = [
  {
    id: 'how-native-works',
    category: 'start',
    title: 'How does Native work?',
    summary: 'A full walkthrough of the launcher: instances, versions, Discover, launching, Locker, Relay, accounts and settings.',
    video: 'full-tour',
    featured: true,
    tags: ['tour', 'overview', 'walkthrough', 'start', 'basics', 'video'],
    steps: [
      { title: 'Sign in', body: 'Use a Microsoft account for official servers, or a Native account for offline play and cloud features.' },
      { title: 'Create an instance', body: 'An instance is one Minecraft install with its own version, mod loader, mods and worlds.' },
      { title: 'Add content', body: 'Open Discover to install mods, modpacks, shaders and resource packs into an instance.' },
      { title: 'Launch', body: 'Pick the instance on Home and press Launch. Native downloads everything the first time.' }
    ],
    action: { label: 'Take the quick tour', kind: 'tour' }
  },
  {
    id: 'create-instance',
    category: 'play',
    title: 'How do I make an instance?',
    summary: 'Create a separate Minecraft install with the version and mod loader you want.',
    video: 'create-instance',
    tags: ['instance', 'new', 'create', 'profile', 'version', 'fabric', 'forge', 'neoforge', 'quilt', 'vanilla'],
    steps: [
      { title: 'Open Instances', body: 'Click Instances in the sidebar, then New instance. You can also press Create & Play on Home.' },
      { title: 'Name it', body: 'Give it a name you will recognise, like "Survival" or "Modded 1.21".' },
      { title: 'Choose the version', body: 'Pick a Minecraft version. If you are unsure, take the latest release.' },
      { title: 'Choose a loader', body: 'Vanilla runs the game as is. Pick Fabric, NeoForge, Forge or Quilt if you want mods.' },
      { title: 'Create', body: 'Press Create. The instance appears on Home and in Instances, ready to launch.' }
    ],
    action: { label: 'Create an instance', kind: 'create-instance' }
  },
  {
    id: 'launch-game',
    category: 'play',
    title: 'How do I launch and play?',
    summary: 'Start Minecraft from Home, follow the first download, and stop the game from the title bar.',
    video: 'launch-game',
    tags: ['launch', 'play', 'start', 'run', 'download', 'stop', 'home'],
    steps: [
      { title: 'Go Home', body: 'Home shows your selected instance. Use the picker to choose another one.' },
      { title: 'Press Launch', body: 'The first launch downloads the game, libraries and Java. Later launches take seconds.' },
      { title: 'While playing', body: 'A running pill appears in the title bar. Click it to open the instance or stop the game.' }
    ],
    action: { label: 'Go to Home', kind: 'tab', tab: 'home' }
  },
  {
    id: 'install-mods',
    category: 'content',
    title: 'How do I install mods?',
    summary: 'Find a mod in Discover and install it into an instance, dependencies included.',
    video: 'install-mods',
    tags: ['mods', 'install', 'discover', 'modrinth', 'sodium', 'optifine', 'download', 'add'],
    steps: [
      { title: 'Use a modded instance', body: 'Mods need a loader. Create or pick an instance that uses Fabric, NeoForge, Forge or Quilt.' },
      { title: 'Open Discover', body: 'Search for a mod, or browse popular ones. Filters show only mods that fit your instance.' },
      { title: 'Install', body: 'Press Install and choose the instance. Required libraries are added for you.' },
      { title: 'Manage', body: 'Open the instance to turn mods on or off, update them or remove them.' }
    ],
    action: { label: 'Open Discover', kind: 'discover', contentType: 'mod' }
  },
  {
    id: 'install-modpack',
    category: 'content',
    title: 'How do I install a modpack?',
    summary: 'Modpacks become their own instance with every mod and setting in place.',
    video: 'install-mods',
    tags: ['modpack', 'pack', 'install', 'mrpack', 'discover'],
    steps: [
      { title: 'Open Discover', body: 'Switch the content type to Modpacks.' },
      { title: 'Pick a pack', body: 'Open it to read the description and choose a version.' },
      { title: 'Install', body: 'Native creates a new instance with the pack, verifies every file and adds it to Home.' }
    ],
    action: { label: 'Browse modpacks', kind: 'discover', contentType: 'modpack' }
  },
  {
    id: 'shaders',
    category: 'content',
    title: 'How do I add shaders or resource packs?',
    summary: 'Install shaders and resource packs from Discover, then turn them on in game.',
    tags: ['shader', 'shaders', 'iris', 'oculus', 'resource pack', 'texture pack', 'textures'],
    steps: [
      { title: 'Shaders need a mod', body: 'Install Iris (Fabric) or Oculus (Forge) into the instance first.' },
      { title: 'Install the pack', body: 'In Discover, switch to Shaders or Resource packs and install into your instance.' },
      { title: 'Turn it on', body: 'In game: Options → Video Settings → Shader Packs, or Options → Resource Packs.' }
    ],
    action: { label: 'Browse shaders', kind: 'discover', contentType: 'shader' }
  },
  {
    id: 'connect-premium',
    category: 'account',
    title: 'How do I connect my premium account to Native?',
    summary: 'Connect once, and every time you sign in with Microsoft you are signed into Native too.',
    video: 'connect-premium',
    tags: ['premium', 'microsoft', 'link', 'connect', 'native account', 'auto', 'sign in', 'relay'],
    steps: [
      { title: 'Sign in with Microsoft', body: 'Add your premium (Microsoft) account in Accounts.' },
      { title: 'Press Connect', body: 'Next to the Microsoft account, press Connect.' },
      { title: 'Sign into Native', body: 'Choose a signed-in Native account or enter your Native login. Native checks with Microsoft that you own the game.' },
      { title: 'Done', body: 'From now on, Relay, friends and chat work while you play with your premium account, on every PC.' }
    ],
    action: { label: 'Connect Native', kind: 'accounts', connect: true }
  },
  {
    id: 'locker',
    category: 'account',
    title: 'How do I change my skin and cape?',
    summary: 'Upload skins, pick capes and preview them in 3D in the Locker.',
    video: 'locker',
    tags: ['skin', 'cape', 'locker', 'wardrobe', 'avatar', '3d', 'slim', 'classic'],
    steps: [
      { title: 'Open Locker', body: 'Click Locker in the sidebar. It needs a Native account.' },
      { title: 'Add a skin', body: 'Drop a skin PNG or choose one, and pick the classic or slim model.' },
      { title: 'Apply', body: 'Select a skin or cape to wear it. Other Native players see it in game.' }
    ],
    action: { label: 'Open Locker', kind: 'tab', tab: 'skins' }
  },
  {
    id: 'relay',
    category: 'account',
    title: 'How do I add friends and chat?',
    summary: 'Relay is Native’s chat: friends, groups, presence and one-click server joining.',
    video: 'relay',
    tags: ['friends', 'chat', 'relay', 'message', 'group', 'dm', 'add friend', 'social'],
    steps: [
      { title: 'Open Relay', body: 'Click Relay in the sidebar. You need a Native account, or a premium account connected to one.' },
      { title: 'Add a friend', body: 'Search their Native name and send a request. They accept it from their Relay.' },
      { title: 'Chat', body: 'Send messages, images and GIFs, or make a group for your crew.' }
    ],
    action: { label: 'Open Relay', kind: 'tab', tab: 'relay' }
  },
  {
    id: 'join-friend',
    category: 'account',
    title: 'How do I join a friend’s server?',
    summary: 'See which server a friend is on and join with one click.',
    video: 'relay',
    tags: ['join', 'server', 'friend', 'multiplayer', 'presence'],
    steps: [
      { title: 'Check presence', body: 'Friends who are playing show what they are doing, like "In-game: Hypixel".' },
      { title: 'Join', body: 'Right-click the friend and choose Join server. Native launches your instance and connects.' }
    ],
    action: { label: 'Open Relay', kind: 'tab', tab: 'relay' }
  },
  {
    id: 'more-ram',
    category: 'help',
    title: 'How do I give Minecraft more RAM?',
    summary: 'Set memory for every instance in Settings, or for one instance in its own settings.',
    video: 'settings-memory',
    tags: ['ram', 'memory', 'lag', 'performance', 'settings', 'allocate', 'gb'],
    steps: [
      { title: 'Open Settings', body: 'Go to Settings → Game & Display.' },
      { title: 'Move the slider', body: '4–6 GB suits most modpacks. Leave some memory for your system.' },
      { title: 'Per instance', body: 'Open an instance’s settings to give only that instance more memory.' }
    ],
    action: { label: 'Open game settings', kind: 'settings', tab: 'minecraft' }
  },
  {
    id: 'quick-search',
    category: 'start',
    title: 'How do I find anything quickly?',
    summary: 'Quick search finds pages, instances, mods, friends, settings and guides from anywhere.',
    video: 'quick-search',
    tags: ['search', 'quick search', 'ctrl k', 'find', 'command', 'shortcut'],
    steps: [
      { title: 'Open it', body: 'Click Search in the title bar or press Ctrl + K.' },
      { title: 'Type', body: 'Results update as you type: instances, pages, settings, friends, guides and mods from Discover.' },
      { title: 'Go', body: 'Use the arrow keys and Enter. Shift + Enter launches an instance straight away.' }
    ],
    action: { label: 'Open quick search', kind: 'search' }
  },
  {
    id: 'crash',
    category: 'help',
    title: 'The game crashed. What now?',
    summary: 'Native reads the crash log, explains the cause and offers one-click fixes.',
    tags: ['crash', 'error', 'exit code', 'broken', 'fix', 'not starting', 'log'],
    steps: [
      { title: 'Read the report', body: 'After a crash, a report opens with the likely cause in plain words.' },
      { title: 'Apply a fix', body: 'Use the suggested fix (more memory, the right Java, disabling a mod) and relaunch.' },
      { title: 'Share it', body: 'Still stuck? Share the report link with a friend or on Discord.' }
    ]
  },
  {
    id: 'java',
    category: 'help',
    title: 'Which Java do I need?',
    summary: 'Native picks and installs the right Java automatically for every version.',
    tags: ['java', 'jdk', 'jre', 'runtime', 'version', '17', '21', '8'],
    steps: [
      { title: 'Automatic', body: 'Minecraft 1.20.5+ needs Java 21, 1.17–1.20.4 Java 17, and older versions Java 8. Native downloads it for you.' },
      { title: 'Custom', body: 'To use your own Java, go to Settings → Java & Arguments.' }
    ],
    action: { label: 'Open Java settings', kind: 'settings', tab: 'java' }
  },
  {
    id: 'files',
    category: 'help',
    title: 'Where are my worlds, screenshots and files?',
    summary: 'Every instance keeps its own folder. Open it from the instance page.',
    tags: ['files', 'folder', 'worlds', 'saves', 'screenshots', 'backup', 'location', 'storage'],
    steps: [
      { title: 'Open the instance', body: 'Click an instance, then Worlds or Screenshots.' },
      { title: 'Open the folder', body: 'Use Open folder to see the files on disk. Storage settings show where everything lives.' }
    ],
    action: { label: 'Open storage settings', kind: 'settings', tab: 'storage' }
  },
  {
    id: 'update',
    category: 'help',
    title: 'How do I update Native?',
    summary: 'Native updates itself. You only need to restart.',
    tags: ['update', 'upgrade', 'new version', 'release notes', 'changelog'],
    steps: [
      { title: 'Automatic', body: 'When an update is ready, a pill appears in the title bar.' },
      { title: 'Restart', body: 'Click it and choose Restart to install. Release notes are in Settings → Release Notes.' }
    ],
    action: { label: 'Release notes', kind: 'settings', tab: 'changelog' }
  }
];

/** Built-in video locations; the hosted manifest can override any of them. */
export function defaultVideo(id) {
  return {
    id,
    src: `${GUIDE_MEDIA_ROOT}/${id}.mp4`,
    poster: `${GUIDE_MEDIA_ROOT}/${id}.jpg`,
    duration: null,
    chapters: []
  };
}

let manifestPromise = null;

export function loadGuideManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache', signal: AbortSignal.timeout(8000) })
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => (json && typeof json === 'object' && json.videos ? json : null))
      .catch(() => null)
      .then((json) => {
        if (!json) manifestPromise = null; // try again next time
        return json;
      });
  }
  return manifestPromise;
}

const SAFE_MEDIA = /^https:\/\/api\.nativelaunch\.xyz\/guides\/[A-Za-z0-9._-]+\.(?:mp4|webm|jpg|png|webp|vtt)$/;

function cleanVideo(id, entry) {
  const base = defaultVideo(id);
  if (!entry || typeof entry !== 'object') return base;
  return {
    ...base,
    src: SAFE_MEDIA.test(entry.src || '') ? entry.src : base.src,
    poster: SAFE_MEDIA.test(entry.poster || '') ? entry.poster : base.poster,
    captions: SAFE_MEDIA.test(entry.captions || '') ? entry.captions : null,
    duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
    start: Number.isFinite(Number(entry.start)) && Number(entry.start) > 0 ? Number(entry.start) : 0,
    title: typeof entry.title === 'string' ? entry.title.slice(0, 120) : null,
    chapters: Array.isArray(entry.chapters)
      ? entry.chapters
        .filter((chapter) => Number.isFinite(Number(chapter?.t)) && typeof chapter?.label === 'string')
        .map((chapter) => ({ t: Number(chapter.t), label: chapter.label.slice(0, 80) }))
        .slice(0, 40)
      : []
  };
}

/** { [videoId]: video } with manifest data merged in once it loads. */
export function useGuideVideos() {
  const [manifest, setManifest] = useState(null);
  // 'loading' until the hosted manifest answers; built-in defaults are only used
  // if it fails, so the player never flashes an outdated poster or video first.
  const [state, setState] = useState('loading');
  useEffect(() => {
    let cancelled = false;
    loadGuideManifest().then((json) => {
      if (cancelled) return;
      if (json) setManifest(json);
      setState(json ? 'ready' : 'failed');
    });
    return () => { cancelled = true; };
  }, []);
  const videos = {};
  for (const guide of GUIDES) {
    if (guide.video && !videos[guide.video]) {
      videos[guide.video] = state === 'loading'
        ? { id: guide.video, pending: true, src: null, poster: null, duration: null, chapters: [] }
        : cleanVideo(guide.video, manifest?.videos?.[guide.video]);
    }
  }
  return videos;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function guideById(id) {
  return GUIDES.find((guide) => guide.id === id) || null;
}
