import { describe, expect, it } from 'vitest';
import { estimateBuildingHeight } from '../utils/heightHeuristics';

describe('estimateBuildingHeight', () => {
  it('prefers measured height > 0 over floors and class heuristics', () => {
    expect(estimateBuildingHeight(24.36, 3, 'residential', 50)).toEqual({
      effectiveHeight: 24.4,
      heightSource: 'measured',
    });
  });

  it('uses num_floors * 3.2 when measured height is missing or non-positive', () => {
    expect(estimateBuildingHeight(null, 4, 'residential', 80)).toEqual({
      effectiveHeight: 12.8,
      heightSource: 'floors',
    });
    expect(estimateBuildingHeight(0, 2, 'commercial', 120)).toEqual({
      effectiveHeight: 6.4,
      heightSource: 'floors',
    });
  });

  it('estimates residential heights across footprint area tiers', () => {
    expect(estimateBuildingHeight(null, null, 'residential', 60)).toEqual({
      effectiveHeight: 4.2,
      heightSource: 'estimated',
    });
    expect(estimateBuildingHeight(null, 0, 'House', 120)).toEqual({
      effectiveHeight: 6.0,
      heightSource: 'estimated',
    });
    expect(estimateBuildingHeight(undefined, undefined, 'apartments', 260)).toEqual({
      effectiveHeight: 7.8,
      heightSource: 'estimated',
    });
  });

  it('estimates commercial/civic/mixed_use heights scaled between 9.5m and 14.0m', () => {
    const small = estimateBuildingHeight(null, null, 'commercial', 40);
    const medium = estimateBuildingHeight(null, null, 'school', 500);
    const mixedUse = estimateBuildingHeight(null, null, 'mixed_use', 500);
    const huge = estimateBuildingHeight(null, null, 'hospital', 50_000);

    expect(small).toEqual({ effectiveHeight: 9.5, heightSource: 'estimated' });
    expect(medium.heightSource).toBe('estimated');
    expect(medium.effectiveHeight).toBeGreaterThan(9.5);
    expect(medium.effectiveHeight).toBeLessThan(14.0);
    expect(mixedUse.heightSource).toBe('estimated');
    expect(mixedUse.effectiveHeight).toBeGreaterThan(9.5);
    expect(mixedUse.effectiveHeight).toBeLessThan(14.0);
    expect(huge).toEqual({ effectiveHeight: 14.0, heightSource: 'estimated' });
  });

  it('estimates industrial and religious classes', () => {
    expect(estimateBuildingHeight(null, null, 'warehouse', 800)).toEqual({
      effectiveHeight: 8.5,
      heightSource: 'estimated',
    });
    expect(estimateBuildingHeight(null, null, 'cathedral', 600)).toEqual({
      effectiveHeight: 11.0,
      heightSource: 'estimated',
    });
  });

  it('falls back by footprint area for unknown classes', () => {
    expect(estimateBuildingHeight(null, null, 'unknown', 40)).toEqual({
      effectiveHeight: 4.5,
      heightSource: 'estimated',
    });
    expect(estimateBuildingHeight(null, null, null, 100)).toEqual({
      effectiveHeight: 6.0,
      heightSource: 'estimated',
    });
    expect(estimateBuildingHeight(null, null, undefined, 250)).toEqual({
      effectiveHeight: 7.5,
      heightSource: 'estimated',
    });
    expect(estimateBuildingHeight(null, null, 'other', 600)).toEqual({
      effectiveHeight: 9.0,
      heightSource: 'estimated',
    });
    // Missing area defaults to 100 m² -> 6.0m
    expect(estimateBuildingHeight(null, null, 'unknown', null)).toEqual({
      effectiveHeight: 6.0,
      heightSource: 'estimated',
    });
  });
});
