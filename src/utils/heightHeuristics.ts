export type HeightSource = 'measured' | 'floors' | 'estimated';

export interface EstimatedHeightResult {
  effectiveHeight: number;
  heightSource: HeightSource;
}

const RESIDENTIAL_CLASSES = new Set([
  'residential',
  'house',
  'detached',
  'apartments',
  'semidetached_house',
  'terrace',
  'bungalow',
  'dormitory',
]);

const COMMERCIAL_CIVIC_CLASSES = new Set([
  'commercial',
  'office',
  'retail',
  'civic',
  'public',
  'school',
  'college',
  'education',
  'hospital',
  'clinic',
  'healthcare',
  'government',
  'hotel',
  'university',
  'mixed_use',
]);

const INDUSTRIAL_CLASSES = new Set([
  'industrial',
  'warehouse',
  'factory',
  'manufacture',
  'shed',
]);

const RELIGIOUS_CLASSES = new Set([
  'religious',
  'church',
  'cathedral',
  'chapel',
  'mosque',
  'temple',
]);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * TypeScript mirror of the Bacolod City 3D height cascade:
 * 1) Measured height > 0 -> 'measured'
 * 2) num_floors > 0 -> num_floors * 3.2 ('floors')
 * 3) Class + footprint area heuristic -> 'estimated'
 */
export function estimateBuildingHeight(
  height: number | null | undefined,
  numFloors: number | null | undefined,
  bclass?: string | null,
  areaM2?: number | null
): EstimatedHeightResult {
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
    return {
      effectiveHeight: round1(height),
      heightSource: 'measured',
    };
  }

  if (
    typeof numFloors === 'number' &&
    Number.isFinite(numFloors) &&
    numFloors > 0
  ) {
    return {
      effectiveHeight: round1(numFloors * 3.2),
      heightSource: 'floors',
    };
  }

  const cls = (bclass ?? 'unknown').toLowerCase().trim();
  const area =
    typeof areaM2 === 'number' && Number.isFinite(areaM2) && areaM2 > 0
      ? areaM2
      : 100;

  if (RESIDENTIAL_CLASSES.has(cls)) {
    const h = area < 80 ? 4.2 : area < 200 ? 6.0 : 7.8;
    return { effectiveHeight: h, heightSource: 'estimated' };
  }

  if (COMMERCIAL_CIVIC_CLASSES.has(cls)) {
    const scaled = 9.5 + Math.log10(Math.max(area, 50) / 50) * 3.0;
    const h = round1(Math.min(14.0, Math.max(9.5, scaled)));
    return { effectiveHeight: h, heightSource: 'estimated' };
  }

  if (INDUSTRIAL_CLASSES.has(cls)) {
    return { effectiveHeight: 8.5, heightSource: 'estimated' };
  }

  if (RELIGIOUS_CLASSES.has(cls)) {
    return { effectiveHeight: 11.0, heightSource: 'estimated' };
  }

  const fallback =
    area < 60 ? 4.5 : area < 150 ? 6.0 : area < 400 ? 7.5 : 9.0;
  return { effectiveHeight: fallback, heightSource: 'estimated' };
}
