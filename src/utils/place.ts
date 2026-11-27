/**
 * The place (LGU) the app is showing. Chosen once at start-up from the URL hash (`place=talisay`),
 * defaulting to Bacolod, and described by public/data/<slug>/place.json, which the pipeline writes
 * (scripts/export_place_meta.py). Every data URL in the app goes through placeFile().
 */
import type { LandmarkItem } from '../layers/types';

export interface CameraPreset {
  id: string;
  label: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface PlaceMeta {
  slug: string;
  name: string;
  displayName: string;
  kind: 'city' | 'municipality';
  province: string;
  psgc: string;
  filePrefix: string;
  center: [number, number];
  bbox: [number, number, number, number];
  barangayCount: number;
  population2020: number;
  homeView: { center: [number, number]; zoom: number; pitch: number; bearing: number };
  cameraPresets: CameraPreset[];
  landmarks: LandmarkItem[];
}

export interface PlaceIndexEntry {
  slug: string;
  displayName: string;
  kind: string;
  status: string;
  center: [number, number];
  bbox: [number, number, number, number];
}

export const DEFAULT_PLACE_SLUG = 'bacolod';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Slug from a URL hash such as "#place=talisay&z=14"; invalid or missing values give the default. */
export function placeSlugFromHash(hash: string): string {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  const slug = (params.get('place') || '').toLowerCase();
  return SLUG_RE.test(slug) ? slug : DEFAULT_PLACE_SLUG;
}

export const PLACE_SLUG: string =
  typeof window === 'undefined' ? DEFAULT_PLACE_SLUG : placeSlugFromHash(window.location.hash);

/** Path of a data file for the current place, relative to the app base URL ("data/bacolod/x.json"). */
export function placeFile(name: string, slug: string = PLACE_SLUG): string {
  return `data/${slug}/${name}`;
}

/** "${placePmtiles('roads')}" */
export function placePmtiles(kind: 'buildings' | 'roads' | 'base'): string {
  return placeFile(`${current?.filePrefix ?? PLACE_SLUG}_${kind}.pmtiles`);
}

let current: PlaceMeta | null = null;

export function setPlaceMeta(meta: PlaceMeta): void {
  current = meta;
}

/** The loaded place, or null before start-up (and in unit tests). */
export function tryGetPlaceMeta(): PlaceMeta | null {
  return current;
}

/** The loaded place. main.tsx loads it before rendering, so components can call this synchronously. */
export function getPlaceMeta(): PlaceMeta {
  if (!current) throw new Error('Place metadata not loaded yet (loadPlaceMeta runs before render)');
  return current;
}

export async function loadPlaceMeta(baseUrl: string, slug: string = PLACE_SLUG): Promise<PlaceMeta> {
  const res = await fetch(`${baseUrl}${placeFile('place.json', slug)}`);
  let meta: PlaceMeta | null = null;
  if (res.ok) {
    // Static hosts and dev servers may answer a missing file with the app's index.html.
    meta = (await res.json().catch(() => null)) as PlaceMeta | null;
  }
  if (!meta || meta.slug !== slug) throw new Error(`No data for place "${slug}"`);
  setPlaceMeta(meta);
  return meta;
}

export async function loadPlaceIndex(baseUrl: string): Promise<PlaceIndexEntry[]> {
  try {
    const res = await fetch(`${baseUrl}data/places.json`);
    if (!res.ok) return [];
    return ((await res.json()) as { places: PlaceIndexEntry[] }).places ?? [];
  } catch {
    return [];
  }
}
