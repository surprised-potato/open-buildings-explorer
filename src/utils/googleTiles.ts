const GOOGLE_SESSION_STORAGE_KEY = 'bacolod_google_tiles_session_v1';
const BASE_URL = 'https://tile.googleapis.com/v1';
const REFRESH_MARGIN_SECONDS = 3600; // Refresh 1 hour before expiry

export interface GoogleSessionData {
  session: string;
  expiry: number;
  tileWidth: number;
  tileHeight: number;
}

interface CachedGoogleSession extends GoogleSessionData {
  keyHash: string;
  mapType: 'satellite';
}

function fingerprintKey(apiKey: string): string {
  let hash = 2166136261;
  for (let i = 0; i < apiKey.length; i += 1) {
    hash ^= apiKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${apiKey.length}:${(hash >>> 0).toString(36)}`;
}

export function getEnvGoogleApiKey(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? '';
}

export function clearGoogleSessionCache(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(GOOGLE_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures
  }
}

function readCachedSession(keyHash: string): GoogleSessionData | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(GOOGLE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedGoogleSession>;
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      parsed.keyHash === keyHash &&
      parsed.mapType === 'satellite' &&
      typeof parsed.session === 'string' &&
      parsed.session.length > 0 &&
      typeof parsed.expiry === 'number' &&
      parsed.expiry - REFRESH_MARGIN_SECONDS > nowSec
    ) {
      return {
        session: parsed.session,
        expiry: parsed.expiry,
        tileWidth: parsed.tileWidth ?? 256,
        tileHeight: parsed.tileHeight ?? 256,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCachedSession(keyHash: string, data: GoogleSessionData): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: CachedGoogleSession = {
      ...data,
      keyHash,
      mapType: 'satellite',
    };
    window.localStorage.setItem(GOOGLE_SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota failures
  }
}

/**
 * Resolve or create an official Google Map Tiles API 2D satellite session.
 * Sessions last ~2 weeks and are cached in localStorage keyed by API key fingerprint.
 */
export async function createGoogleSatelliteSession(
  apiKey: string
): Promise<GoogleSessionData> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('Google Maps API key is empty.');
  }

  const keyHash = fingerprintKey(trimmed);
  const cached = readCachedSession(keyHash);
  if (cached) return cached;

  const response = await fetch(
    `${BASE_URL}/createSession?key=${encodeURIComponent(trimmed)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mapType: 'satellite',
        language: 'en-US',
        region: 'PH',
      }),
    }
  );

  const data = (await response.json().catch(() => ({}))) as {
    session?: string;
    expiry?: string | number;
    tileWidth?: number;
    tileHeight?: number;
    error?: { message?: string };
  };

  if (!response.ok || data.error || !data.session) {
    const msg =
      data.error?.message ||
      `Google Map Tiles session failed (HTTP ${response.status})`;
    throw new Error(msg);
  }

  const expiryNum =
    typeof data.expiry === 'number'
      ? data.expiry
      : Number(data.expiry) || Math.floor(Date.now() / 1000) + 86400;

  const sessionData: GoogleSessionData = {
    session: data.session,
    expiry: expiryNum,
    tileWidth: data.tileWidth ?? 256,
    tileHeight: data.tileHeight ?? 256,
  };

  writeCachedSession(keyHash, sessionData);
  return sessionData;
}

export function buildGoogleSatelliteTileUrl(
  session: string,
  apiKey: string
): string {
  return `${BASE_URL}/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(apiKey.trim())}`;
}
