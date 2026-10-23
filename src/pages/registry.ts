import type { Component } from 'vue';
import Backend from './backend/index.vue';
import Characters from './characters/index.vue';
import Gallery from './gallery/index.vue';
import History from './history/index.vue';
import Settings from './settings/index.vue';

export interface PageDef {
  /** Unique id, stored in ui.activePage / localStorage; also used as the Icon name */
  id: string;
  /** Full name shown in the navigation bar */
  label: string;
  component: Component;
}

/**
 * Page registry. To add a page: create pages/<id>/index.vue, add one line here,
 * and add an icon with the same id to PATHS in Icon.vue. Order is navigation order; settings stays last.
 */
export const PAGES: PageDef[] = [
  { id: 'backend', label: 'Backend', component: Backend },
  { id: 'characters', label: 'Characters', component: Characters },
  { id: 'gallery', label: 'Gallery', component: Gallery },
  { id: 'history', label: 'Request History', component: History },
  { id: 'settings', label: 'Settings', component: Settings },
];

export function getPage(id: string): PageDef {
  return PAGES.find(p => p.id === id) ?? PAGES[0];
}
