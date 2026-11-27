import { describe, expect, it } from 'vitest';
import { buildElevationProfile, samplePathPoints } from '../utils/elevationProfile';

describe('elevationProfile', () => {
  it('resamples a polyline into evenly spaced stations', () => {
    const coords: [number, number][] = [
      [122.950, 10.670],
      [122.954, 10.670],
    ];
    const stations = samplePathPoints(coords, 11);
    expect(stations).toHaveLength(11);
    expect(stations[0].distanceM).toBe(0);
    expect(stations[10].distanceM).toBeGreaterThan(400);
    expect(stations[5].lon).toBeCloseTo(122.952, 5);
  });

  it('computes terrain gain, loss, slope, and sliced building silhouettes', () => {
    const coords: [number, number][] = [
      [122.950, 10.670],
      [122.955, 10.670],
    ];

    const result = buildElevationProfile(
      coords,
      (lon) => {
        // Rises linearly from 10m to 30m in first half, then drops to 20m
        if (lon <= 122.9525) {
          return 10 + ((lon - 122.950) / 0.0025) * 20;
        }
        return 30 - ((lon - 122.9525) / 0.0025) * 10;
      },
      (lon) => {
        if (lon >= 122.951 && lon <= 122.952) {
          return { id: 'bldg-a', name: 'Tower A', bclass: 'commercial', effectiveHeight: 18 };
        }
        if (lon >= 122.9535 && lon <= 122.954) {
          return { id: 'bldg-b', name: 'Hall B', bclass: 'civic', effectiveHeight: 12 };
        }
        return null;
      },
      21
    );

    expect(result.samples).toHaveLength(21);
    expect(result.minGroundM).toBeCloseTo(10, 1);
    expect(result.maxGroundM).toBeCloseTo(30, 1);
    expect(result.totalGainM).toBeCloseTo(20, 1);
    expect(result.totalLossM).toBeCloseTo(10, 1);
    expect(result.maxRoofM).toBeGreaterThan(36);
    expect(result.maxSlopePct).toBeGreaterThan(1);
    expect(result.buildingsSlicedCount).toBe(2);
  });
});
