import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACE_SLUG, placeFile, placeSlugFromHash } from '../utils/place';
import { decodeUrlState, encodeUrlState } from '../utils/urlState';

describe('place selection', () => {
  it('reads the place from the hash and falls back to Bacolod', () => {
    expect(placeSlugFromHash('#place=talisay&z=14')).toBe('talisay');
    expect(placeSlugFromHash('')).toBe(DEFAULT_PLACE_SLUG);
    expect(placeSlugFromHash('#place=../../etc')).toBe(DEFAULT_PLACE_SLUG);
    expect(placeSlugFromHash('#place=Silay')).toBe('silay');
  });

  it('builds data paths under the place folder', () => {
    expect(placeFile('boundaries.geojson', 'bago')).toBe('data/bago/boundaries.geojson');
  });

  it('keeps the place in the shareable hash, omitting the default', () => {
    expect(encodeUrlState({ place: 'talisay', zoom: 12 })).toContain('place=talisay');
    expect(encodeUrlState({ place: 'bacolod', zoom: 12 })).not.toContain('place=');
    expect(decodeUrlState('#place=cadiz&z=12').place).toBe('cadiz');
    expect(decodeUrlState('#place=<script>').place).toBeUndefined();
  });
});
