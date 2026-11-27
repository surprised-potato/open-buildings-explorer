import { describe, expect, it } from 'vitest';
import {
  decodeUrlState,
  encodeUrlState,
  type UrlViewState,
} from '../utils/urlState';

describe('urlState serialization', () => {
  it('round-trips full camera and visualization state', () => {
    const input: UrlViewState = {
      center: [122.9509, 10.6765],
      zoom: 14.8,
      pitch: 58,
      bearing: -18,
      theme: 'satellite',
      colorMode: 'source',
      terrainEnabled: true,
      terrainExaggeration: 1.5,
      sunHour: 16.25,
      hiddenLayers: ['roads', 'boundaries'],
    };

    const hash = encodeUrlState(input);
    expect(hash.startsWith('#')).toBe(true);

    const decoded = decodeUrlState(hash);
    expect(decoded.center?.[0]).toBeCloseTo(122.9509, 5);
    expect(decoded.center?.[1]).toBeCloseTo(10.6765, 5);
    expect(decoded.zoom).toBeCloseTo(14.8, 2);
    expect(decoded.pitch).toBe(58);
    expect(decoded.bearing).toBe(-18);
    expect(decoded.theme).toBe('satellite');
    expect(decoded.colorMode).toBe('source');
    expect(decoded.terrainEnabled).toBe(true);
    expect(decoded.terrainExaggeration).toBeCloseTo(1.5, 1);
    expect(decoded.sunHour).toBeCloseTo(16.25, 2);
    expect(decoded.hiddenLayers).toEqual(['roads', 'boundaries']);
  });

  it('returns empty string for empty state', () => {
    expect(encodeUrlState({})).toBe('');
  });

  it('handles empty, whitespace, and malformed hashes safely', () => {
    expect(decodeUrlState('')).toEqual({});
    expect(decodeUrlState('#')).toEqual({});
    expect(decodeUrlState('#   ')).toEqual({});
    expect(decodeUrlState(null as unknown as string)).toEqual({});
    expect(decodeUrlState('lng=abc&lat=xyz&z=99&p=-5&t=neon&cm=magic')).toEqual(
      {}
    );
  });

  it('ignores out-of-bounds values while keeping valid fields', () => {
    const decoded = decodeUrlState(
      '#lng=250&lat=10.67&z=15&t=light&ter=0&ex=99&sun=25&off=roads,,landmarks'
    );
    expect(decoded.center).toBeUndefined();
    expect(decoded.zoom).toBe(15);
    expect(decoded.theme).toBe('light');
    expect(decoded.terrainEnabled).toBe(false);
    expect(decoded.terrainExaggeration).toBeUndefined();
    expect(decoded.sunHour).toBeUndefined();
    expect(decoded.hiddenLayers).toEqual(['roads', 'landmarks']);
  });

  it('accepts boolean-style terrain flags without leading hash', () => {
    expect(decodeUrlState('ter=true&cm=clay')).toEqual({
      terrainEnabled: true,
      colorMode: 'clay',
    });
    expect(decodeUrlState('ter=false')).toEqual({
      terrainEnabled: false,
    });
  });
});

describe('urlState view', () => {
  it('round-trips a non-default view and omits explore', () => {
    expect(decodeUrlState(encodeUrlState({ view: 'reports' })).view).toBe('reports');
    expect(encodeUrlState({ view: 'explore' })).toBe('');
    expect(decodeUrlState('#v=bogus').view).toBeUndefined();
  });
});
