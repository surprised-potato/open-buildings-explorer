import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGoogleSatelliteTileUrl,
  clearGoogleSessionCache,
  createGoogleSatelliteSession,
} from '../utils/googleTiles';

describe('googleTiles', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearGoogleSessionCache();
    vi.restoreAllMocks();
  });

  it('creates and caches a Google Map Tiles satellite session keyed by API key', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        session: 'sess-abc-123',
        expiry: String(futureExpiry),
        tileWidth: 256,
        tileHeight: 256,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await createGoogleSatelliteSession('AIzaTestKey1');
    expect(first.session).toBe('sess-abc-123');
    expect(first.expiry).toBe(futureExpiry);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call with same key should hit localStorage cache without calling fetch
    const second = await createGoogleSatelliteSession('AIzaTestKey1');
    expect(second.session).toBe('sess-abc-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Different API key should bypass cache and create a new session
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        session: 'sess-xyz-999',
        expiry: futureExpiry,
        tileWidth: 256,
        tileHeight: 256,
      }),
    });
    const third = await createGoogleSatelliteSession('AIzaTestKey2');
    expect(third.session).toBe('sess-xyz-999');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws descriptive errors on empty key or API error responses', async () => {
    await expect(createGoogleSatelliteSession('   ')).rejects.toThrow(
      'Google Maps API key is empty.'
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { message: 'API key not valid.' },
        }),
      })
    );

    await expect(createGoogleSatelliteSession('bad-key')).rejects.toThrow(
      'API key not valid.'
    );
  });

  it('formats 2D satellite tile URL template with session and key', () => {
    const url = buildGoogleSatelliteTileUrl('sess+1/2', 'key=abc');
    expect(url).toBe(
      'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=sess%2B1%2F2&key=key%3Dabc'
    );
  });
});
