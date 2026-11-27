import type { AppView, BasemapTheme, BuildingColorMode } from '../layers/types';

export interface UrlViewState {
  center?: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  theme?: BasemapTheme;
  colorMode?: BuildingColorMode;
  terrainEnabled?: boolean;
  terrainExaggeration?: number;
  sunHour?: number;
  hiddenLayers?: string[];
  view?: AppView;
}

const VALID_THEMES = new Set<BasemapTheme>(['dark', 'light', 'satellite']);
const VALID_VIEWS = new Set<AppView>(['explore', 'analyze', 'simulate', 'reports']);
const VALID_COLOR_MODES = new Set<BuildingColorMode>([
  'height',
  'source',
  'class',
  'clay',
]);

function parseFinite(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Serialize camera and twin visualization preferences into a URL hash string.
 */
export function encodeUrlState(state: UrlViewState): string {
  const params = new URLSearchParams();

  if (
    state.center &&
    Number.isFinite(state.center[0]) &&
    Number.isFinite(state.center[1])
  ) {
    params.set('lng', state.center[0].toFixed(5));
    params.set('lat', state.center[1].toFixed(5));
  }
  if (typeof state.zoom === 'number' && Number.isFinite(state.zoom)) {
    params.set('z', state.zoom.toFixed(2));
  }
  if (typeof state.pitch === 'number' && Number.isFinite(state.pitch)) {
    params.set('p', Math.round(state.pitch).toString());
  }
  if (typeof state.bearing === 'number' && Number.isFinite(state.bearing)) {
    params.set('b', Math.round(state.bearing).toString());
  }
  if (state.theme && VALID_THEMES.has(state.theme)) {
    params.set('t', state.theme);
  }
  if (state.colorMode && VALID_COLOR_MODES.has(state.colorMode)) {
    params.set('cm', state.colorMode);
  }
  if (typeof state.terrainEnabled === 'boolean') {
    params.set('ter', state.terrainEnabled ? '1' : '0');
  }
  if (
    typeof state.terrainExaggeration === 'number' &&
    Number.isFinite(state.terrainExaggeration)
  ) {
    params.set('ex', state.terrainExaggeration.toFixed(1));
  }
  if (typeof state.sunHour === 'number' && Number.isFinite(state.sunHour)) {
    params.set('sun', state.sunHour.toFixed(2));
  }
  if (state.hiddenLayers && state.hiddenLayers.length > 0) {
    params.set('off', state.hiddenLayers.join(','));
  }

  if (state.view && state.view !== 'explore' && VALID_VIEWS.has(state.view)) {
    params.set('v', state.view);
  }

  const encoded = params.toString();
  return encoded ? `#${encoded}` : '';
}

/**
 * Parse a URL hash string back into partial twin camera & layer state.
 * Returns an empty object on empty or malformed input.
 */
export function decodeUrlState(hash: string): UrlViewState {
  if (!hash || typeof hash !== 'string') return {};
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!cleaned.trim()) return {};

  try {
    const params = new URLSearchParams(cleaned);
    const result: UrlViewState = {};

    const lng = parseFinite(params.get('lng'));
    const lat = parseFinite(params.get('lat'));
    if (
      lng !== undefined &&
      lat !== undefined &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90
    ) {
      result.center = [lng, lat];
    }

    const zoom = parseFinite(params.get('z'));
    if (zoom !== undefined && zoom >= 0 && zoom <= 24) {
      result.zoom = zoom;
    }

    const pitch = parseFinite(params.get('p'));
    if (pitch !== undefined && pitch >= 0 && pitch <= 85) {
      result.pitch = pitch;
    }

    const bearing = parseFinite(params.get('b'));
    if (bearing !== undefined && bearing >= -360 && bearing <= 360) {
      result.bearing = bearing;
    }

    const theme = params.get('t') as BasemapTheme | null;
    if (theme && VALID_THEMES.has(theme)) {
      result.theme = theme;
    }

    const colorMode = params.get('cm') as BuildingColorMode | null;
    if (colorMode && VALID_COLOR_MODES.has(colorMode)) {
      result.colorMode = colorMode;
    }

    const ter = params.get('ter');
    if (ter === '1' || ter === 'true') {
      result.terrainEnabled = true;
    } else if (ter === '0' || ter === 'false') {
      result.terrainEnabled = false;
    }

    const ex = parseFinite(params.get('ex'));
    if (ex !== undefined && ex >= 0 && ex <= 5) {
      result.terrainExaggeration = ex;
    }

    const sun = parseFinite(params.get('sun'));
    if (sun !== undefined && sun >= 0 && sun <= 24) {
      result.sunHour = sun;
    }

    const off = params.get('off');
    if (off) {
      const hidden = off
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      if (hidden.length > 0) {
        result.hiddenLayers = hidden;
      }
    }

    const view = params.get('v') as AppView | null;
    if (view && VALID_VIEWS.has(view)) {
      result.view = view;
    }

    return result;
  } catch {
    return {};
  }
}
