import { onSettingsReady, settings } from '@/state/settings';
import { reactive, ref, watch } from 'vue';

/**
 * Teleport host for dialogs: mounted by App.vue as a direct child of .bbi-root (outside the .bbi-body scroll container).
 * All .bbi-modal-mask dialogs teleport here, avoiding an old iOS Safari problem:
 * "position:fixed descendants inside a scrollable ancestor" are positioned relative to the scrolled content instead of the viewport, so after scrolling the settings page, dialogs got pushed off screen.
 * Still inside the shadow root, so scoped styles and --bbi-* theme variables work as usual (hence Teleport to="body" can't be used).
 */
export const modalHost = ref<HTMLElement | null>(null);

/** Navigation position: auto = top on PC, bottom on mobile */
export type NavPosition = 'top' | 'bottom' | 'auto';

/**
 * Themes. To add a theme:
 *   1) add a set of .bbi-root[data-theme='xxx'] variables in theme.css;
 *   2) add 'xxx' to ThemeName here and register an entry in THEMES.
 * The settings page and the title-bar switch button both read THEMES automatically; nothing else needs changing.
 */
export type ThemeName = 'day' | 'night' | 'pastel' | 'green' | 'st';

export interface ThemeDef {
  value: ThemeName;
  label: string;
  /** Icon component name, see components/Icon.vue */
  icon: string;
}

export const THEMES: ThemeDef[] = [
  { value: 'day', label: 'Light', icon: 'sun' },
  { value: 'night', label: 'Dark', icon: 'moon' },
  { value: 'pastel', label: 'Pastel', icon: 'sparkles' },
  { value: 'green', label: 'Warm white', icon: 'sparkles' },
  { value: 'st', label: 'Follow SillyTavern', icon: 'plug' },
];

interface UiState {
  open: boolean;
  /** Current page id, matching a key in the registry */
  activePage: string;
  theme: ThemeName;
  navPosition: NavPosition;
  /** Mobile: tapping the current page's nav button again closes the window (on by default; can be turned off to avoid mis-taps) */
  navTapClose: boolean;
  /** Inject a quick-open button into ST's top bar (off by default) */
  showTopBar: boolean;
  /** Screen-edge floating orb (off by default) */
  showOrb: boolean;
  /** Custom floating-orb icon (ST server image path; empty = default brush icon) */
  orbImage: string;
  /** Floating-orb shape: bookmark / circle / square */
  orbShape: OrbShape;
  /** Floating-orb idle opacity (percent, 20–100) */
  orbOpacity: number;
  /** Floating-orb base size (px, 32–80) */
  orbSize: number;
}

/** Floating-orb shape */
export type OrbShape = 'bookmark' | 'circle' | 'square';
export const ORB_SHAPES: { value: OrbShape; label: string }[] = [
  { value: 'bookmark', label: 'Bookmark' },
  { value: 'circle', label: 'Circle' },
  { value: 'square', label: 'Square' },
];
function validOrbShape(s: string): OrbShape {
  return s === 'bookmark' || s === 'circle' || s === 'square' ? s : 'bookmark';
}

// activePage (the page last visited) is purely local temporary navigation state; syncing it across devices is pointless, and writing to the server on every page change is too frequent,
// so it stays in local localStorage; theme/navigation position are real settings and are stored in settings.ui (→ ST cross-device sync).
const PAGE_STORAGE_KEY = 'bbi.ui.page.v1';

function loadActivePage(): string {
  try {
    return localStorage.getItem(PAGE_STORAGE_KEY) || 'backend';
  } catch {
    return 'backend';
  }
}

// Theme validity check: settings.ui.theme is a bare string that may come from an old version or be hand-edited wrong, so validate before passing to ui.
function validTheme(t: string): ThemeName {
  return THEMES.some(x => x.value === t) ? (t as ThemeName) : 'day';
}
function validNav(n: string): NavPosition {
  return n === 'top' || n === 'bottom' || n === 'auto' ? n : 'auto';
}

// Build ui from the current settings values first (mostly defaults at import time; onSettingsReady restores the real values after hydrate).
export const ui = reactive<UiState>({
  open: false,
  activePage: loadActivePage(),
  theme: validTheme(settings.ui.theme),
  navPosition: validNav(settings.ui.navPosition),
  navTapClose: settings.ui.navTapClose,
  showTopBar: settings.ui.showTopBar,
  showOrb: settings.ui.showOrb,
  orbImage: settings.ui.orbImage,
  orbShape: validOrbShape(settings.ui.orbShape),
  orbOpacity: settings.ui.orbOpacity,
  orbSize: settings.ui.orbSize,
});

// Once settings' cross-device values are ready, restore theme/navigation into ui (overriding the import-time defaults)
onSettingsReady(() => {
  ui.theme = validTheme(settings.ui.theme);
  ui.navPosition = validNav(settings.ui.navPosition);
  ui.navTapClose = settings.ui.navTapClose;
  ui.showTopBar = settings.ui.showTopBar;
  ui.showOrb = settings.ui.showOrb;
  ui.orbImage = settings.ui.orbImage;
  ui.orbShape = validOrbShape(settings.ui.orbShape);
  ui.orbOpacity = settings.ui.orbOpacity;
  ui.orbSize = settings.ui.orbSize;
});

// ui changes → written back to settings.ui (settings' watch saves with debounce and syncs across devices); activePage still stays local.
watch(
  () => [
    ui.theme,
    ui.navPosition,
    ui.navTapClose,
    ui.showTopBar,
    ui.showOrb,
    ui.orbImage,
    ui.orbShape,
    ui.orbOpacity,
    ui.orbSize,
  ],
  () => {
    settings.ui.theme = ui.theme;
    settings.ui.navPosition = ui.navPosition;
    settings.ui.navTapClose = ui.navTapClose;
    settings.ui.showTopBar = ui.showTopBar;
    settings.ui.showOrb = ui.showOrb;
    settings.ui.orbImage = ui.orbImage;
    settings.ui.orbShape = ui.orbShape;
    settings.ui.orbOpacity = ui.orbOpacity;
    settings.ui.orbSize = ui.orbSize;
  },
);
watch(
  () => ui.activePage,
  () => {
    try {
      localStorage.setItem(PAGE_STORAGE_KEY, ui.activePage);
    } catch {
      /* Silent when localStorage is unavailable */
    }
  },
);

/**
 * Timestamp of the window's most recent opening. Used to ignore mask-close clicks at the moment of opening:
 * on mobile, the click synthesised at the end of the opening gesture passes through to the freshly rendered mask, causing an "instant close".
 */
export let lastOpenedAt = 0;

export function openPanel(page?: string) {
  if (page) ui.activePage = page;
  ui.open = true;
  lastOpenedAt = performance.now();
}

export function closePanel() {
  ui.open = false;
}

/** Title-bar button: cycles through all registered themes */
export function cycleTheme() {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  ui.theme = THEMES[(i + 1) % THEMES.length].value;
}
