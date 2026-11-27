import { describe, expect, it } from 'vitest';
import type { BuildingPoiRecord } from '../layers/types';
import { analyzeSiteCatchment, type CatchmentGridData } from '../utils/siteSelection';

describe('analyzeSiteCatchment', () => {
  const sampleGrid: CatchmentGridData = {
    cell_size_m: 250,
    columns: [
      'lon',
      'lat',
      'total_buildings',
      'residential_buildings',
      'residential_footprint_m2',
      'commercial_buildings',
      'has_arterial_road',
    ],
    cells: [
      [122.950, 10.670, 220, 190, 28_000, 18, 1],
      [122.952, 10.671, 180, 155, 24_000, 12, 1],
      // Far away cell outside 500m
      [122.990, 10.710, 300, 280, 40_000, 5, 0],
    ],
  };

  const samplePois: Record<string, BuildingPoiRecord> = {
    'b-1': {
      id: 'b-1',
      name: 'Lacson Plaza Hub',
      label: 'Lacson Plaza Hub (+2)',
      center: [122.9505, 10.6702],
      bclass: 'mixed_use',
      class_source: 'osm_poi_inside',
      effective_height: 12.5,
      height_source: 'estimated',
      num_floors: null,
      area_m2: 900,
      primary_source: 'OpenStreetMap',
      poi_count: 3,
      pois: [
        {
          osm_id: 'node/1',
          name: 'Calea Cafe',
          category: 'food',
          poi_key: 'amenity',
          poi_value: 'cafe',
          match_method: 'inside',
          match_distance_m: 0,
        },
        {
          osm_id: 'node/2',
          name: 'BPI Branch',
          category: 'commercial',
          poi_key: 'amenity',
          poi_value: 'bank',
          match_method: 'inside',
          match_distance_m: 0,
        },
        {
          osm_id: 'node/3',
          name: 'Metro Mart',
          category: 'retail',
          poi_key: 'shop',
          poi_value: 'supermarket',
          match_method: 'inside',
          match_distance_m: 0,
        },
      ],
    },
    'b-far': {
      id: 'b-far',
      name: 'Far Store',
      label: 'Far Store',
      center: [122.990, 10.710],
      bclass: 'retail',
      class_source: 'osm_poi_inside',
      effective_height: 10,
      height_source: 'estimated',
      num_floors: null,
      area_m2: 200,
      primary_source: 'OpenStreetMap',
      poi_count: 1,
      pois: [
        {
          osm_id: 'node/99',
          name: 'Far Pharmacy',
          category: 'healthcare',
          poi_key: 'amenity',
          poi_value: 'pharmacy',
          match_method: 'inside',
          match_distance_m: 0,
        },
      ],
    },
  };

  it('scores a high-demand low-competition site higher than an oversaturated/empty site', () => {
    const underservedHealth = analyzeSiteCatchment({
      center: [122.9505, 10.6703],
      radiusM: 500,
      targetCategory: 'healthcare',
      buildingPois: samplePois,
      catchmentGrid: sampleGrid,
      groundElevationM: 9.5,
    });

    expect(underservedHealth.totalBuildings).toBe(400);
    expect(underservedHealth.residentialBuildings).toBe(345);
    expect(underservedHealth.directCompetitorCount).toBe(0);
    expect(underservedHealth.complementaryPoiCount).toBe(3);
    expect(underservedHealth.arterialRoadCells).toBe(2);
    expect(underservedHealth.scores.competitionGapScore).toBe(100);
    expect(underservedHealth.scores.elevationSafetyScore).toBe(100);
    expect(underservedHealth.scores.overallScore).toBeGreaterThanOrEqual(65);
    expect(underservedHealth.anchors).toHaveLength(1);
    expect(underservedHealth.anchors[0].buildingId).toBe('b-1');

    const emptyLowSite = analyzeSiteCatchment({
      center: [122.910, 10.620],
      radiusM: 500,
      targetCategory: 'food',
      buildingPois: samplePois,
      catchmentGrid: sampleGrid,
      groundElevationM: 1.0,
    });

    expect(emptyLowSite.totalBuildings).toBe(0);
    expect(emptyLowSite.scores.elevationSafetyScore).toBe(30);
    expect(emptyLowSite.scores.overallScore).toBeLessThan(underservedHealth.scores.overallScore);
  });
});
