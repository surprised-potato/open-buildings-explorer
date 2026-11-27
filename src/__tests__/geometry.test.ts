import { describe, expect, it } from 'vitest';
import {
  computePathLengthMeters,
  computePolygonAreaSqMeters,
  formatArea,
  formatDistance,
} from '../utils/geometry';

describe('geometry utilities', () => {
  describe('computePathLengthMeters', () => {
    it('returns 0 for fewer than 2 points', () => {
      expect(computePathLengthMeters([])).toBe(0);
      expect(computePathLengthMeters([[122.9509, 10.6765]])).toBe(0);
    });

    it('computes geodesic distance between Bacolod Public Plaza and New Government Center', () => {
      const publicPlaza: [number, number] = [122.9482, 10.6713];
      const ngc: [number, number] = [122.9636, 10.6606];
      const dist = computePathLengthMeters([publicPlaza, ngc]);
      // Straight-line distance in Bacolod is ~2,060 meters
      expect(dist).toBeGreaterThan(1950);
      expect(dist).toBeLessThan(2200);
    });

    it('sums multi-segment paths accurately', () => {
      const p1: [number, number] = [122.9482, 10.6713];
      const p2: [number, number] = [122.9535, 10.6765];
      const p3: [number, number] = [122.9636, 10.6606];
      const directSum =
        computePathLengthMeters([p1, p2]) + computePathLengthMeters([p2, p3]);
      expect(computePathLengthMeters([p1, p2, p3])).toBeCloseTo(directSum, 6);
    });
  });

  describe('computePolygonAreaSqMeters', () => {
    it('returns 0 for fewer than 3 vertices or degenerate rings', () => {
      expect(computePolygonAreaSqMeters([])).toBe(0);
      expect(
        computePolygonAreaSqMeters([
          [122.95, 10.67],
          [122.951, 10.67],
        ])
      ).toBe(0);
    });

    it('treats closed and unclosed rings identically', () => {
      const openRing: [number, number][] = [
        [122.948, 10.671],
        [122.949, 10.671],
        [122.949, 10.672],
        [122.948, 10.672],
      ];
      const closedRing: [number, number][] = [...openRing, openRing[0]];
      const areaOpen = computePolygonAreaSqMeters(openRing);
      const areaClosed = computePolygonAreaSqMeters(closedRing);
      expect(areaOpen).toBeCloseTo(areaClosed, 6);
    });

    it('computes realistic square-meter area at Bacolod latitude (~10.6765°N)', () => {
      // ~0.001 deg lat ≈ 111.19 m; ~0.001 deg lon at 10.6765°N ≈ 109.27 m => ~12,150 m²
      const box: [number, number][] = [
        [122.95, 10.676],
        [122.951, 10.676],
        [122.951, 10.677],
        [122.95, 10.677],
      ];
      const area = computePolygonAreaSqMeters(box);
      expect(area).toBeGreaterThan(11_500);
      expect(area).toBeLessThan(12_800);
    });
  });

  describe('formatDistance', () => {
    it('formats invalid, short, medium, and kilometer distances', () => {
      expect(formatDistance(0)).toBe('0 m');
      expect(formatDistance(-5)).toBe('0 m');
      expect(formatDistance(Number.NaN)).toBe('0 m');
      expect(formatDistance(4.26)).toBe('4.3 m');
      expect(formatDistance(245.6)).toBe('246 m');
      expect(formatDistance(1000)).toBe('1.00 km');
      expect(formatDistance(2345)).toBe('2.35 km');
    });
  });

  describe('formatArea', () => {
    it('formats invalid, square meters, hectares, and square kilometers', () => {
      expect(formatArea(0)).toBe('0 m²');
      expect(formatArea(-10)).toBe('0 m²');
      expect(formatArea(Number.POSITIVE_INFINITY)).toBe('0 m²');
      expect(formatArea(345.7)).toBe('346 m²');
      expect(formatArea(12_500)).toBe('1.25 ha');
      expect(formatArea(2_500_000)).toBe('2.50 km²');
    });
  });
});
