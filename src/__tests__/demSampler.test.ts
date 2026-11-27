import { describe, expect, it } from 'vitest';
import { DemGridSampler, formatElevation } from '../utils/demSampler';

describe('DemGridSampler', () => {
  // 2x2 grid covering lon [122.90, 123.00], lat [10.60, 10.70]
  // Row 0 (north=10.70): [10.0m, 20.0m] -> raw [100, 200]
  // Row 1 (south=10.60): [30.0m, 50.0m] -> raw [300, 500]
  const sampler = new DemGridSampler({
    width: 2,
    height: 2,
    bbox: [122.9, 10.6, 123.0, 10.7],
    scale: 0.1,
    nodata: -32768,
    data: new Int16Array([100, 200, 300, 500]),
  });

  it('returns exact corner elevations', () => {
    expect(sampler.sampleElevation(122.9, 10.7)).toBeCloseTo(10.0, 4);
    expect(sampler.sampleElevation(123.0, 10.7)).toBeCloseTo(20.0, 4);
    expect(sampler.sampleElevation(122.9, 10.6)).toBeCloseTo(30.0, 4);
    expect(sampler.sampleElevation(123.0, 10.6)).toBeCloseTo(50.0, 4);
  });

  it('performs bilinear interpolation at midpoint and edge midpoints', () => {
    // Center: average of (10, 20, 30, 50) = 27.5
    expect(sampler.sampleElevation(122.95, 10.65)).toBeCloseTo(27.5, 4);
    // North edge midpoint: (10 + 20) / 2 = 15.0
    expect(sampler.sampleElevation(122.95, 10.7)).toBeCloseTo(15.0, 4);
  });

  it('returns null outside bounding box or on invalid coordinates', () => {
    expect(sampler.sampleElevation(122.89, 10.65)).toBeNull();
    expect(sampler.sampleElevation(123.01, 10.65)).toBeNull();
    expect(sampler.sampleElevation(122.95, 10.71)).toBeNull();
    expect(sampler.sampleElevation(Number.NaN, 10.65)).toBeNull();
  });

  it('gracefully handles partial and all-nodata cells', () => {
    const partial = new DemGridSampler({
      width: 2,
      height: 2,
      bbox: [122.9, 10.6, 123.0, 10.7],
      scale: 0.1,
      nodata: -32768,
      data: new Int16Array([100, -32768, -32768, -32768]),
    });
    expect(partial.sampleElevation(122.95, 10.65)).toBeCloseTo(10.0, 4);

    const empty = new DemGridSampler({
      width: 2,
      height: 2,
      bbox: [122.9, 10.6, 123.0, 10.7],
      scale: 0.1,
      nodata: -32768,
      data: new Int16Array([-32768, -32768, -32768, -32768]),
    });
    expect(empty.sampleElevation(122.95, 10.65)).toBeNull();
  });
});

describe('formatElevation', () => {
  it('formats meters ASL and null fallback', () => {
    expect(formatElevation(null)).toBe('—');
    expect(formatElevation(-0.01)).toBe('0.0 m ASL');
    expect(formatElevation(42.36)).toBe('42.4 m ASL');
  });
});
