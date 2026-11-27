import type { BuildingPoiRecord } from '../layers/types';
import { computePathLengthMeters } from './geometry';

export interface CatchmentGridData {
  cell_size_m: number;
  columns: string[];
  /** [lon, lat, total_buildings, residential_buildings, residential_footprint_m2, commercial_buildings, has_arterial_road] */
  cells: Array<[number, number, number, number, number, number, number]>;
}

export interface SiteCategoryOption {
  value: string;
  label: string;
  color: string;
}

export const SITE_CATEGORIES: SiteCategoryOption[] = [
  { value: 'food', label: 'Food & Dining', color: '#f97316' },
  { value: 'retail', label: 'Retail & Shops', color: '#fb923c' },
  { value: 'commercial', label: 'Commercial Services', color: '#f59e0b' },
  { value: 'office', label: 'Offices', color: '#818cf8' },
  { value: 'hotel', label: 'Hotels & Lodging', color: '#fbbf24' },
  { value: 'healthcare', label: 'Healthcare', color: '#f43f5e' },
  { value: 'education', label: 'Education', color: '#2dd4bf' },
  { value: 'civic', label: 'Civic & Gov', color: '#34d399' },
  { value: 'religious', label: 'Religious', color: '#e879f9' },
  { value: 'leisure', label: 'Leisure & Fitness', color: '#38bdf8' },
  { value: 'industrial', label: 'Industrial', color: '#a78bfa' },
];

export interface SiteCompetitor {
  poiId: string;
  name: string;
  tag: string;
  buildingId: string;
  buildingName: string | null;
  distanceM: number;
  coordinates: [number, number];
}

export interface SiteAnchorHub {
  buildingId: string;
  name: string;
  bclass: string;
  poiCount: number;
  distanceM: number;
  coordinates: [number, number];
}

export interface SiteScoreBreakdown {
  demandScore: number;
  footTrafficScore: number;
  competitionGapScore: number;
  accessibilityScore: number;
  elevationSafetyScore: number;
  overallScore: number;
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C' | 'D';
}

export interface SiteAnalysisResult {
  center: [number, number];
  radiusM: number;
  targetCategory: string;
  areaKm2: number;
  totalBuildings: number;
  residentialBuildings: number;
  residentialFootprintM2: number;
  commercialBuildings: number;
  arterialRoadCells: number;
  cellCount: number;
  directCompetitorCount: number;
  complementaryPoiCount: number;
  groundElevationM: number | null;
  scores: SiteScoreBreakdown;
  competitors: SiteCompetitor[];
  anchors: SiteAnchorHub[];
}

function scoreToGrade(score: number): SiteScoreBreakdown['grade'] {
  if (score >= 88) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 72) return 'B+';
  if (score >= 64) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Evaluate commercial site viability inside a circular catchment around `center`.
 */
export function analyzeSiteCatchment(params: {
  center: [number, number];
  radiusM: number;
  targetCategory: string;
  buildingPois: Record<string, BuildingPoiRecord>;
  catchmentGrid: CatchmentGridData | null;
  groundElevationM: number | null;
}): SiteAnalysisResult {
  const {
    center,
    radiusM,
    targetCategory,
    buildingPois,
    catchmentGrid,
    groundElevationM,
  } = params;

  const safeRadius = Math.max(50, radiusM);
  const areaKm2 = (Math.PI * safeRadius * safeRadius) / 1_000_000;

  let totalBuildings = 0;
  let residentialBuildings = 0;
  let residentialFootprintM2 = 0;
  let commercialBuildings = 0;
  let arterialRoadCells = 0;
  let cellCount = 0;

  if (catchmentGrid && Array.isArray(catchmentGrid.cells)) {
    const halfCellPadding = (catchmentGrid.cell_size_m || 250) * 0.35;
    const effectiveRadius = safeRadius + halfCellPadding;
    for (const cell of catchmentGrid.cells) {
      const [lon, lat, totalB, resB, resArea, commB, hasArterial] = cell;
      const dist = computePathLengthMeters([center, [lon, lat]]);
      if (dist <= effectiveRadius) {
        cellCount += 1;
        totalBuildings += totalB;
        residentialBuildings += resB;
        residentialFootprintM2 += resArea;
        commercialBuildings += commB;
        if (hasArterial > 0) arterialRoadCells += 1;
      }
    }
  }

  const competitors: SiteCompetitor[] = [];
  const anchors: SiteAnchorHub[] = [];
  let directCompetitorCount = 0;
  let complementaryPoiCount = 0;

  for (const rec of Object.values(buildingPois)) {
    if (!Array.isArray(rec.center) || rec.center.length < 2) continue;
    const dist = computePathLengthMeters([center, rec.center]);
    if (dist > safeRadius) continue;

    let hasComplementary = false;
    for (const poi of rec.pois ?? []) {
      if (poi.category === targetCategory) {
        directCompetitorCount += 1;
        competitors.push({
          poiId: poi.osm_id,
          name: poi.name?.trim() || `${poi.poi_key}=${poi.poi_value}`,
          tag: `${poi.poi_key}=${poi.poi_value}`,
          buildingId: rec.id,
          buildingName: rec.name ?? null,
          distanceM: Math.round(dist),
          coordinates: rec.center,
        });
      } else {
        complementaryPoiCount += 1;
        hasComplementary = true;
      }
    }

    if (hasComplementary || rec.poi_count >= 2) {
      anchors.push({
        buildingId: rec.id,
        name: rec.name?.trim() || rec.label || `${rec.bclass} hub`,
        bclass: rec.bclass,
        poiCount: rec.poi_count,
        distanceM: Math.round(dist),
        coordinates: rec.center,
      });
    }
  }

  competitors.sort((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name));
  anchors.sort((a, b) => b.poiCount - a.poiCount || a.distanceM - b.distanceM);

  const resDensity = residentialFootprintM2 / Math.max(areaKm2, 0.01);
  const demandScore = clampScore((1 - Math.exp(-resDensity / 70_000)) * 105);

  const compPoiDensity = complementaryPoiCount / Math.max(areaKm2, 0.01);
  const footTrafficScore = clampScore((1 - Math.exp(-compPoiDensity / 45)) * 105);

  const competitorDensity = directCompetitorCount / Math.max(areaKm2, 0.01);
  let competitionGapScore: number;
  if (residentialBuildings === 0 && complementaryPoiCount === 0) {
    competitionGapScore = 20;
  } else {
    const demandFactor = Math.max(0.25, demandScore / 100);
    const saturation = competitorDensity / (22 * demandFactor);
    competitionGapScore = clampScore(Math.max(10, 100 * Math.exp(-0.55 * saturation)));
  }

  const accessibilityScore =
    cellCount > 0 ? clampScore((arterialRoadCells / cellCount) * 120) : 0;

  const elevationSafetyScore =
    groundElevationM === null || !Number.isFinite(groundElevationM)
      ? 70
      : groundElevationM >= 8
        ? 100
        : groundElevationM >= 4
          ? 82
          : groundElevationM >= 2
            ? 58
            : 30;

  const overallScore = clampScore(
    demandScore * 0.3 +
      footTrafficScore * 0.25 +
      competitionGapScore * 0.25 +
      accessibilityScore * 0.1 +
      elevationSafetyScore * 0.1
  );

  return {
    center,
    radiusM: safeRadius,
    targetCategory,
    areaKm2: Number(areaKm2.toFixed(2)),
    totalBuildings,
    residentialBuildings,
    residentialFootprintM2,
    commercialBuildings,
    arterialRoadCells,
    cellCount,
    directCompetitorCount,
    complementaryPoiCount,
    groundElevationM,
    scores: {
      demandScore,
      footTrafficScore,
      competitionGapScore,
      accessibilityScore,
      elevationSafetyScore,
      overallScore,
      grade: scoreToGrade(overallScore),
    },
    competitors: competitors.slice(0, 25),
    anchors: anchors.slice(0, 6),
  };
}
