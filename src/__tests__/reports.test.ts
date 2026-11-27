import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORTS } from '../reports/catalog';
import { reportToCsv, reportToHtml, tableToCsv } from '../reports/export';
import type { ReportContext } from '../reports/types';
import type { BarangayAnalyticsDataset, BuildingPoiRecord } from '../layers/types';
import { createEmptyMobilityStats } from '../utils/mobilityTypes';

const analytics = JSON.parse(
  readFileSync('public/data/bacolod/barangay_analytics.json', 'utf8')
) as BarangayAnalyticsDataset;
const poiFile = JSON.parse(readFileSync('public/data/bacolod/building_pois.json', 'utf8')) as Record<
  string,
  BuildingPoiRecord
>;

const purposeMix = {
  demand: JSON.parse(readFileSync('public/data/bacolod/barangay_demand.json', 'utf8')),
  demographics: JSON.parse(readFileSync('public/data/bacolod/barangay_demographics.json', 'utf8')),
  typology: JSON.parse(readFileSync('public/data/bacolod/barangay_typology.json', 'utf8')),
};
const property = JSON.parse(readFileSync('public/data/bacolod/barangay_property.json', 'utf8'));

const ctx = (over: Partial<ReportContext> = {}): ReportContext => ({
  property,
  purposeMix,
  tripGen: null,
  corridors: null,
  corridorA: null,
  corridorB: null,
  analytics,
  pois: poiFile,
  barangay: analytics.barangays[0].name,
  mobilityStats: createEmptyMobilityStats(),
  zonalTierCounts: [10, 20, 30, 0],
  zonalTierLabels: ['', 'a', 'b', 'c', 'd'],
  ...over,
});

describe('reports', () => {
  it('every report builds with real data and exports', () => {
    for (const def of REPORTS) {
      const out = def.build(ctx());
      expect(out.title.length).toBeGreaterThan(0);
      expect(reportToCsv(out)).toContain(out.title);
      expect(reportToHtml(out)).toContain('<h1>');
    }
  });

  it('city snapshot totals match the citywide record', () => {
    const out = REPORTS.find((r) => r.id === 'city-snapshot')!.build(ctx());
    const facts = new Map(out.sections[0].facts);
    expect(facts.get('Buildings')).toBe(analytics.citywide.building_count.toLocaleString('en-PH'));
  });

  it('ranking has one row per barangay', () => {
    const out = REPORTS.find((r) => r.id === 'barangay-ranking')!.build(ctx());
    const table = out.sections.find((s) => s.table)!.table!;
    expect(table.rows).toHaveLength(analytics.barangays.length);
  });

  it('profile needs a barangay and ranks it', () => {
    const def = REPORTS.find((r) => r.id === 'barangay-profile')!;
    expect(def.build(ctx({ barangay: null })).sections).toHaveLength(0);
    const out = def.build(ctx());
    expect(out.sections[0].table!.rows[1][2]).toMatch(/^\d+ of \d+$/);
  });

  it('csv escapes commas, quotes and newlines', () => {
    const csv = tableToCsv({ columns: ['a'], rows: [['x,"y"\nz']] });
    expect(csv).toBe('a\r\n"x,""y""\nz"');
  });

  it('mobility report explains when the sim data is unavailable', () => {
    const out = REPORTS.find((r) => r.id === 'mobility-snapshot')!.build(ctx());
    expect(out.subtitle).toBe('Simulation data unavailable');
  });

  it('property report totals match the data file', () => {
    const out = REPORTS.find((r) => r.id === 'property-value')!.build(ctx());
    const rows = out.sections[1].table!.rows;
    expect(rows).toHaveLength(Object.keys(property.barangays).length);
    const buildings = rows.reduce((s, r) => s + (r[1] as number), 0);
    expect(out.subtitle).toContain(buildings.toLocaleString('en-PH'));
  });

  it('exposure report lists surge and low-lying barangays and handles missing data', () => {
    const def = REPORTS.find((r) => r.id === 'terrain-exposure')!;
    const out = def.build(ctx());
    const low = out.sections.find((s) => s.heading.startsWith('Low-lying proxy'))!.table!.rows;
    expect(low.length).toBeGreaterThan(0);
    expect(low.every((r) => (r[3] as number) > 0)).toBe(true);
    const surge = out.sections.find((s) => s.heading.startsWith('Storm surge by barangay'))!.table!.rows;
    expect(surge.length).toBeGreaterThan(5);
    const reached = surge.reduce((sum, r) => sum + (r[1] as number), 0);
    const expected = Object.values(property.barangays as Record<string, { surge: number[] }>).reduce(
      (sum, b) => sum + b.surge.slice(1).reduce((x, y) => x + y, 0),
      0
    );
    expect(reached).toBe(expected);
    expect(out.caveats.some((c) => c.includes('flood maps') && c.includes('do not cover'))).toBe(true);
    expect(def.build(ctx({ property: null })).subtitle).toBe('Loading data…');
  });

  it('trip purpose report varies by barangay and the profile carries the expected mix', () => {
    const out = REPORTS.find((r) => r.id === 'trip-purpose')!.build(ctx());
    const rows = out.sections[1].table!.rows;
    expect(rows).toHaveLength(61);
    const school = rows.map((r) => parseFloat(String(r[6])));
    expect(Math.max(...school) - Math.min(...school)).toBeGreaterThan(8);
    expect(out.sections[0].table!.rows.length).toBeGreaterThanOrEqual(3);
    const prof = REPORTS.find((r) => r.id === 'barangay-profile')!.build(ctx());
    expect(prof.sections.some((s) => s.heading.includes('trip purpose'))).toBe(true);
    expect(REPORTS.find((r) => r.id === 'trip-purpose')!.build(ctx({ purposeMix: null })).subtitle).toBe('Loading data…');
  });
});
