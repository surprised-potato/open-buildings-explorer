import type { BarangayAnalyticsItem } from '../layers/types';
import {
  MOBILITY_MODE_LABELS,
  MOBILITY_PURPOSE_LABELS,
  type MobilityModeId,
  type MobilityPurposeId,
} from '../utils/mobilityTypes';
import type { ReportChart } from './charts';
import type { CorridorRow } from './corridors';
import type { BuildingTripRow } from './tripGeneration';
import type { ReportContext, ReportDefinition, ReportOutput } from './types';

const n0 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : Math.round(v).toLocaleString('en-PH');
const n1 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toLocaleString('en-PH', { maximumFractionDigits: 1 });
const peso = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `₱${n0(v)}/m²`);
const pct = (num: number, den: number) => (den > 0 ? `${((100 * num) / den).toFixed(1)}%` : '–');

const ZONAL_CAVEAT =
  'Zonal values are BIR tax floors per street (RDO 77, DO 058-2023), not market prices, and cover land only.';

function find(ctx: ReportContext, name: string | null): BarangayAnalyticsItem | undefined {
  return ctx.analytics.barangays.find((b) => b.name === name);
}

/** 1-based rank of `item` among all barangays by `get`, higher value = rank 1. */
function rank(
  ctx: ReportContext,
  item: BarangayAnalyticsItem,
  get: (b: BarangayAnalyticsItem) => number | null | undefined
): string {
  const mine = get(item);
  if (mine === null || mine === undefined) return '–';
  const vals = ctx.analytics.barangays.map(get).filter((v): v is number => typeof v === 'number');
  return `${vals.filter((v) => v > mine).length + 1} of ${vals.length}`;
}

function poiTrustCounts(ctx: ReportContext) {
  const out = { verified: 0, unverified: 0, unrated: 0 };
  for (const rec of Object.values(ctx.pois)) {
    for (const p of rec.pois) out[p.trust ?? 'unrated'] += 1;
  }
  return out;
}

const citySnapshot: ReportDefinition = {
  id: 'city-snapshot',
  title: 'City snapshot',
  description: 'One-page summary of Bacolod: buildings, land use mix, POIs, terrain and zonal values.',
  category: 'City',
  build: (ctx): ReportOutput => {
    const c = ctx.analytics.citywide;
    const bs = ctx.analytics.barangays;
    const top = [...bs].sort((a, b) => b.building_count - a.building_count).slice(0, 10);
    return {
      title: 'Bacolod City snapshot',
      subtitle: `Data generated ${ctx.analytics.generated_at.slice(0, 10)}`,
      sections: [
        {
          heading: 'Built environment',
          facts: [
            ['Barangays', n0(c.barangays)],
            ['Area', `${n1(c.area_km2)} km²`],
            ['Buildings', n0(c.building_count)],
            ['Built coverage', `${n1(c.built_coverage_pct)}%`],
            ['Est. gross floor area', `${n1(c.est_gfa_m2 / 1e6)} million m²`],
            ['Mean elevation', c.mean_elev_m === null ? '–' : `${n1(c.mean_elev_m)} m`],
            ['Low-lying share', `${n1(c.low_lying_pct)}%`],
            ['Green space share', `${n1(c.green_space_pct)}%`],
          ],
        },
        {
          heading: 'Building mix',
          charts: [
            {
              kind: 'donut',
              title: 'Buildings by class',
              centerLabel: 'buildings',
              items: [
                { label: 'Residential', value: c.residential_count },
                { label: 'Commercial', value: c.commercial_count },
                { label: 'Mixed use', value: c.mixed_use_count },
                { label: 'Industrial', value: c.industrial_count },
                { label: 'Civic / education / health', value: c.civic_edu_health_count },
                {
                  label: 'Unclassified / other',
                  value: Math.max(0, c.building_count - c.residential_count - c.commercial_count - c.mixed_use_count - c.industrial_count - c.civic_edu_health_count),
                },
              ],
            },
          ],
          table: {
            columns: ['Class', 'Buildings', 'Share'],
            rows: [
              ['Residential', c.residential_count],
              ['Commercial', c.commercial_count],
              ['Mixed use', c.mixed_use_count],
              ['Industrial', c.industrial_count],
              ['Civic / education / health', c.civic_edu_health_count],
            ].map(([k, v]) => [k, n0(v as number), pct(v as number, c.building_count)]),
          },
          note: `${n0(c.poi_count)} points of interest in total.`,
        },
        {
          heading: 'Most built-up barangays',
          charts: [
            { kind: 'bar', title: 'Buildings, top 10 barangays', items: top.map((b) => ({ label: b.name, value: b.building_count })) },
          ],
          table: {
            columns: ['Barangay', 'Buildings', 'Coverage %', 'Commercial %'],
            rows: top.map((b) => [b.name, n0(b.building_count), n1(b.built_coverage_pct), n1(b.commercial_share_pct)]),
          },
        },
      ],
      caveats: [
        'Building classes come from OSM tags, Overture and heuristics; many buildings are unclassified.',
        ZONAL_CAVEAT,
      ],
    };
  },
};

const barangayProfile: ReportDefinition = {
  id: 'barangay-profile',
  title: 'Barangay profile',
  description: 'Everything we know about one barangay, with its rank among all barangays.',
  category: 'Barangay',
  needsBarangay: true,
  build: (ctx): ReportOutput => {
    const b = find(ctx, ctx.barangay);
    if (!b) {
      return { title: 'Barangay profile', subtitle: 'Select a barangay', sections: [], caveats: [] };
    }
    const poiRows = Object.entries(b.poi_by_category)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => [k, n0(v)]);
    return {
      title: `${b.name} profile`,
      subtitle: `Barangay profile · ${ctx.analytics.barangays.length} barangays compared`,
      sections: [
        {
          heading: 'Size and density',
          table: {
            columns: ['Metric', 'Value', 'City rank'],
            rows: [
              ['Area', `${n1(b.area_km2)} km²`, rank(ctx, b, (x) => x.area_km2)],
              ['Buildings', n0(b.building_count), rank(ctx, b, (x) => x.building_count)],
              ['Buildings per km²', n0(b.building_density_per_km2), rank(ctx, b, (x) => x.building_density_per_km2)],
              ['Built coverage', `${n1(b.built_coverage_pct)}%`, rank(ctx, b, (x) => x.built_coverage_pct)],
              ['Est. floor area', `${n0(b.est_gfa_m2)} m²`, rank(ctx, b, (x) => x.est_gfa_m2)],
              ['Mean height', `${n1(b.mean_height_m)} m`, rank(ctx, b, (x) => x.mean_height_m)],
            ],
          },
        },
        {
          heading: 'Land use mix (buildings)',
          charts: [
            {
              kind: 'donut',
              title: 'Buildings by class',
              centerLabel: 'buildings',
              items: [
                { label: 'Residential', value: b.residential_count },
                { label: 'Commercial', value: b.commercial_count },
                { label: 'Mixed use', value: b.mixed_use_count },
                { label: 'Industrial', value: b.industrial_count },
                { label: 'Civic / education / health', value: b.civic_edu_health_count },
                { label: 'Unclassified', value: b.unknown_count },
              ],
            },
          ],
          table: {
            columns: ['Class', 'Buildings', 'Share'],
            rows: [
              ['Residential', b.residential_count],
              ['Commercial', b.commercial_count],
              ['Mixed use', b.mixed_use_count],
              ['Industrial', b.industrial_count],
              ['Civic / education / health', b.civic_edu_health_count],
              ['Unclassified', b.unknown_count],
            ].map(([k, v]) => [k, n0(v as number), pct(v as number, b.building_count)]),
          },
        },
        ...(ctx.purposeMix?.demand.barangays[b.name]
          ? [
              {
                heading: 'Residents’ trip purpose (expected)',
                facts: [
                  ['Area type', ctx.purposeMix.typology?.barangays[b.name]?.label ?? '–'],
                  ['Work', pct(ctx.purposeMix.demand.barangays[b.name].mix.hbw, 1)],
                  ['School', pct(ctx.purposeMix.demand.barangays[b.name].mix.hbe, 1)],
                  ['Other', pct(ctx.purposeMix.demand.barangays[b.name].mix.hbo, 1)],
                ] as Array<[string, string]>,
                charts: [
                  {
                    kind: 'stack',
                    title: 'Trip purpose: this barangay vs city',
                    series: ['Work', 'School', 'Other'],
                    normalize: true,
                    rows: [
                      { label: b.name, values: [ctx.purposeMix.demand.barangays[b.name].mix.hbw, ctx.purposeMix.demand.barangays[b.name].mix.hbe, ctx.purposeMix.demand.barangays[b.name].mix.hbo] },
                      { label: 'City', values: [ctx.purposeMix.demand.meta.cityShares.hbw, ctx.purposeMix.demand.meta.cityShares.hbe, ctx.purposeMix.demand.meta.cityShares.hbo] },
                    ],
                  },
                ] as ReportChart[],
              },
            ]
          : []),
        ...(b.tree_cover_pct !== undefined
          ? [
              {
                heading: 'Land cover (satellite, 10 m)',
                facts: [
                  ['Tree cover', `${n1(b.tree_cover_pct)}%`],
                  ['Built-up', `${n1(b.built_up_pct)}%`],
                  ['Cropland', `${n1(b.cropland_pct)}%`],
                  ['Mapped parks and green space (OSM)', `${n1(b.green_space_pct)}%`],
                ] as Array<[string, string]>,
                charts: [
                  {
                    kind: 'donut',
                    title: 'Land cover (share of area)',
                    centerLabel: '% of area',
                    items: [
                      { label: 'Tree cover', value: b.tree_cover_pct ?? 0 },
                      { label: 'Cropland', value: b.cropland_pct ?? 0 },
                      { label: 'Built-up', value: b.built_up_pct ?? 0 },
                      { label: 'Other', value: Math.max(0, 100 - (b.tree_cover_pct ?? 0) - (b.cropland_pct ?? 0) - (b.built_up_pct ?? 0)) },
                    ],
                  },
                ] as ReportChart[],
                note: 'Tree cover includes canopy over houses and gardens, so it is much higher than mapped parks.',
              },
            ]
          : []),
        {
          heading: 'Terrain',
          facts: [
            ['Mean elevation', b.mean_elev_m === null ? '–' : `${n1(b.mean_elev_m)} m`],
            ['Elevation range', b.min_elev_m === null ? '–' : `${n1(b.min_elev_m)} to ${n1(b.max_elev_m)} m`],
            ['Low-lying share', `${n1(b.low_lying_pct)}%`],
            ['Green space share', `${n1(b.green_space_pct)}%`],
          ],
        },
        {
          heading: 'Points of interest',
          facts: [
            ['Total', n0(b.poi_count)],
            ['Density', `${n1(b.poi_density_per_km2)} per km²`],
          ],
          charts: [
            {
              kind: 'bar',
              title: 'POIs by category',
              items: Object.entries(b.poi_by_category).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => ({ label: k, value: v })),
            },
          ],
          table: { columns: ['Category', 'POIs'], rows: poiRows },
        },
        {
          heading: 'BIR zonal values (land)',
          facts: [
            ['Residential median', peso(b.zonal_res_median)],
            ['Residential max', peso(b.zonal_res_max)],
            ['Commercial median', peso(b.zonal_com_median)],
            ['Commercial max', peso(b.zonal_com_max)],
            ['Street entries', n0(b.zonal_entries)],
          ],
          table: b.zonal_top_commercial?.length
            ? {
                columns: ['Top commercial street', 'Vicinity', 'Value'],
                rows: b.zonal_top_commercial.map((t) => [t.street, t.vicinity, peso(t.value)]),
              }
            : undefined,
        },
      ],
      caveats: [ZONAL_CAVEAT, 'Ranks are by raw value, 1 = highest.'],
    };
  },
};

const ranking: ReportDefinition = {
  id: 'barangay-ranking',
  title: 'Barangay ranking table',
  description: 'All barangays side by side with key metrics. Best exported as CSV for a spreadsheet.',
  category: 'City',
  build: (ctx): ReportOutput => ({
    title: 'Barangay comparison',
    subtitle: `${ctx.analytics.barangays.length} barangays`,
    sections: [
      {
        heading: 'At a glance',
        charts: [
          {
            kind: 'bar',
            title: 'Buildings per km², top 15',
            items: [...ctx.analytics.barangays]
              .sort((a, b) => b.building_density_per_km2 - a.building_density_per_km2)
              .slice(0, 15)
              .map((b) => ({ label: b.name, value: Math.round(b.building_density_per_km2) })),
          },
          {
            kind: 'scatter',
            title: 'Density vs tree cover',
            xLabel: 'Buildings per km²',
            yLabel: 'Tree cover %',
            points: ctx.analytics.barangays
              .filter((b) => b.tree_cover_pct !== undefined)
              .map((b) => ({ label: b.name, x: b.building_density_per_km2, y: b.tree_cover_pct as number })),
            note: 'Each dot is one barangay.',
          },
        ],
      },
      {
        heading: 'Metrics by barangay',
        table: {
          columns: [
            'Barangay', 'Area km²', 'Buildings', 'Buildings/km²', 'Coverage %', 'Commercial %',
            'POIs', 'POIs/km²', 'Low-lying %', 'Green %', 'Tree cover %', 'Zonal res median', 'Zonal com median',
          ],
          rows: [...ctx.analytics.barangays]
            .sort((a, b) => b.building_count - a.building_count)
            .map((b) => [
              b.name, n1(b.area_km2), b.building_count, Math.round(b.building_density_per_km2),
              b.built_coverage_pct, b.commercial_share_pct, b.poi_count, b.poi_density_per_km2,
              b.low_lying_pct, b.green_space_pct, b.tree_cover_pct ?? null, b.zonal_res_median ?? null, b.zonal_com_median ?? null,
            ]),
        },
      },
    ],
    caveats: [ZONAL_CAVEAT],
  }),
};

const businessReport: ReportDefinition = {
  id: 'business-poi',
  title: 'Business & POI report',
  description: 'POI categories per barangay, hubs, and how many pins are verified or need a field check.',
  category: 'Business',
  build: (ctx): ReportOutput => {
    const trust = poiTrustCounts(ctx);
    const total = trust.verified + trust.unverified + trust.unrated;
    const cats = new Map<string, number>();
    for (const b of ctx.analytics.barangays) {
      for (const [k, v] of Object.entries(b.poi_by_category)) cats.set(k, (cats.get(k) ?? 0) + v);
    }
    const unverified: Array<Array<string | number | null>> = [];
    for (const rec of Object.values(ctx.pois)) {
      for (const p of rec.pois) {
        if (p.trust !== 'unverified') continue;
        unverified.push([
          p.name ?? '(unnamed)', p.category, p.source ?? '', p.addr_street ?? '',
          (p.votes ?? []).join(' '), rec.center[1].toFixed(5), rec.center[0].toFixed(5),
        ]);
      }
    }
    unverified.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return {
      title: 'Business & POI report',
      subtitle: `${n0(total)} POIs`,
      sections: [
        {
          heading: 'Location trust',
          charts: [
            {
              kind: 'donut',
              title: 'POI location trust',
              centerLabel: 'POIs',
              items: [
                { label: 'Verified', value: trust.verified },
                { label: 'Unverified', value: trust.unverified },
                { label: 'Unrated', value: trust.unrated },
              ],
            },
          ],
          facts: [
            ['Verified', `${n0(trust.verified)} (${pct(trust.verified, total)})`],
            ['Unverified (needs field check)', `${n0(trust.unverified)} (${pct(trust.unverified, total)})`],
            ['Unrated', `${n0(trust.unrated)} (${pct(trust.unrated, total)})`],
          ],
        },
        {
          heading: 'POIs by category',
          charts: [
            {
              kind: 'bar',
              title: 'POIs by category, top 12',
              items: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ label: k, value: v })),
            },
          ],
          table: {
            columns: ['Category', 'POIs'],
            rows: [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, n0(v)]),
          },
        },
        {
          heading: 'POI density by barangay',
          charts: [
            {
              kind: 'bar',
              title: 'POIs, top 15 barangays',
              items: [...ctx.analytics.barangays].sort((a, b) => b.poi_count - a.poi_count).slice(0, 15).map((b) => ({ label: b.name, value: b.poi_count })),
            },
          ],
          table: {
            columns: ['Barangay', 'POIs', 'per km²', 'Commercial buildings'],
            rows: [...ctx.analytics.barangays]
              .sort((a, b) => b.poi_count - a.poi_count)
              .slice(0, 20)
              .map((b) => [b.name, n0(b.poi_count), n1(b.poi_density_per_km2), n0(b.commercial_count)]),
          },
          note: 'Top 20 barangays by POI count.',
        },
        {
          heading: 'Unverified pins to check on the ground',
          table: {
            columns: ['Name', 'Category', 'Source', 'Street', 'Votes', 'Lat', 'Lng'],
            rows: unverified,
          },
        },
      ],
      caveats: [
        'Trust comes from independent votes (source, street & barangay match, phone conflicts). Unverified does not mean wrong, only that evidence disagrees.',
      ],
    };
  },
};

const dataQuality: ReportDefinition = {
  id: 'data-quality',
  title: 'Data quality & caveats',
  description: 'How much of the city is measured vs estimated, so readers know what to trust.',
  category: 'Quality',
  build: (ctx): ReportOutput => {
    const c = ctx.analytics.citywide;
    const unknownTotal = ctx.analytics.barangays.reduce((s, b) => s + b.unknown_count, 0);
    const trust = poiTrustCounts(ctx);
    const poiTotal = trust.verified + trust.unverified + trust.unrated;
    const tc = ctx.zonalTierCounts;
    const labels = ctx.zonalTierLabels;
    const tcTotal = tc ? tc.reduce((s, v) => s + v, 0) : 0;
    return {
      title: 'Data quality & caveats',
      subtitle: 'What each number rests on',
      sections: [
        {
          heading: 'Building classification',
          charts: [
            {
              kind: 'donut',
              title: 'Classified vs unclassified buildings',
              centerLabel: 'buildings',
              items: [
                { label: 'Classified', value: c.building_count - unknownTotal },
                { label: 'Unclassified', value: unknownTotal },
              ],
            },
          ],
          facts: [
            ['Buildings', n0(c.building_count)],
            ['Unclassified', `${n0(unknownTotal)} (${pct(unknownTotal, c.building_count)})`],
          ],
        },
        {
          heading: 'POI location trust',
          charts: [
            {
              kind: 'donut',
              title: 'POI location trust',
              centerLabel: 'POIs',
              items: [
                { label: 'Verified', value: trust.verified },
                { label: 'Unverified', value: trust.unverified },
                { label: 'Unrated', value: trust.unrated },
              ],
            },
          ],
          facts: [
            ['Verified', `${n0(trust.verified)} (${pct(trust.verified, poiTotal)})`],
            ['Unverified', `${n0(trust.unverified)} (${pct(trust.unverified, poiTotal)})`],
            ['Unrated', `${n0(trust.unrated)} (${pct(trust.unrated, poiTotal)})`],
          ],
        },
        {
          heading: 'Zonal value match level (per building)',
          charts:
            tc && labels
              ? [
                  {
                    kind: 'bar',
                    title: 'Buildings by match level',
                    items: tc.map((v, i) => ({ label: labels[i + 1] ?? `Tier ${i + 1}`, value: v })).filter((x) => x.value > 0),
                  },
                ]
              : undefined,
          table:
            tc && labels
              ? {
                  columns: ['Match', 'Buildings', 'Share'],
                  rows: tc
                    .map((v, i) => [labels[i + 1] ?? `Tier ${i + 1}`, n0(v), pct(v, tcTotal)])
                    .filter((_, i) => tc[i] > 0),
                }
              : undefined,
          note: tc ? undefined : 'Zonal tier counts are still loading or unavailable.',
        },
      ],
      caveats: [
        ZONAL_CAVEAT,
        'Property value estimates assume lot coverage and construction cost per m²; they are indicative only.',
        'Terrain figures use a coarse DEM; low-lying share is a proxy, not a flood model.',
      ],
    };
  },
};

const mobilityReport: ReportDefinition = {
  id: 'mobility-snapshot',
  needsSim: true,
  title: 'Mobility snapshot',
  description: 'Mode and purpose mix, trip length and congestion from the live simulation, or a morning-peak background run.',
  category: 'Mobility',
  build: (ctx): ReportOutput => {
    const s = ctx.mobilityStats;
    if (!s || !s.loaded) {
      return {
        title: 'Mobility snapshot',
        subtitle: 'Simulation data unavailable',
        sections: [{ heading: 'No data', note: 'The simulation data could not be loaded. Check the browser console, or open Simulate.' }],
        caveats: [],
      };
    }
    const modes = Object.keys(MOBILITY_MODE_LABELS) as MobilityModeId[];
    const purposes = Object.keys(MOBILITY_PURPOSE_LABELS) as MobilityPurposeId[];
    const totalM = modes.reduce((a, m) => a + s.modeCounts[m], 0);
    const totalP = purposes.reduce((a, p) => a + s.purposeCounts[p], 0);
    return {
      title: 'Mobility snapshot',
      subtitle: `${s.phaseLabel} · ${n0(s.activeAgents)} active trips`,
      sections: [
        {
          heading: 'Network state',
          facts: [
            ['Active trips', n0(s.activeAgents)],
            ['Mean trip time', `${n1(s.avgTripMin)} min`],
            ['Mean trip length', `${n1(s.avgTripKm)} km`],
            ['Trips within one barangay', `${n1(s.intraZoneShare * 100)}%`],
            ['Travel time index', n1(s.travelTimeIndex)],
            ['Congested links', n0(s.congestedEdgeCount)],
            ['Peak volume / capacity', n1(s.peakVcRatio)],
          ],
        },
        {
          heading: 'Mode share (vehicles)',
          charts: [
            { kind: 'donut', title: 'Trips by mode', centerLabel: 'trips', items: modes.map((m) => ({ label: MOBILITY_MODE_LABELS[m], value: s.modeCounts[m] })) },
          ],
          table: {
            columns: ['Mode', 'Trips', 'Share'],
            rows: modes.map((m) => [MOBILITY_MODE_LABELS[m], n0(s.modeCounts[m]), pct(s.modeCounts[m], totalM)]),
          },
        },
        {
          heading: 'Trip purpose',
          charts: [
            { kind: 'donut', title: 'Trips by purpose', centerLabel: 'trips', items: purposes.map((p) => ({ label: MOBILITY_PURPOSE_LABELS[p], value: s.purposeCounts[p] })) },
          ],
          table: {
            columns: ['Purpose', 'Trips', 'Share'],
            rows: purposes.map((p) => [MOBILITY_PURPOSE_LABELS[p], n0(s.purposeCounts[p]), pct(s.purposeCounts[p], totalP)]),
          },
        },
      ],
      caveats: [
        'Synthetic demand from a gravity model; not calibrated to Bacolod traffic counts, which we do not have.',
        'Cebu (JICA 2014) survey shares are the only reference for mode split.',
      ],
    };
  },
};

const PROPERTY_CAVEAT =
  'Property values are model estimates: land = BIR zonal value x lot area (footprint / assumed coverage); structure = footprint x floors x assumed cost per m². They are not appraisals or market prices.';

const mPeso = (v: number) => (v / 1e6).toLocaleString('en-PH', { maximumFractionDigits: 0 });

function waitingFor(title: string): ReportOutput {
  return {
    title,
    subtitle: 'Loading data…',
    sections: [{ heading: 'Loading', note: 'Property estimates are still loading. Try again in a moment.' }],
    caveats: [],
  };
}

const propertyReport: ReportDefinition = {
  id: 'property-value',
  title: 'Property value estimate',
  description: 'Estimated land and structure value by barangay, built from per-building zonal values.',
  category: 'Property',
  build: (ctx): ReportOutput => {
    const p = ctx.property;
    if (!p) return waitingFor('Property value estimate');
    const rows = Object.entries(p.barangays).map(([name, b]) => ({ name, b, total: b.land + b.structure }));
    rows.sort((x, y) => y.total - x.total);
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
    const land = sum((r) => r.b.land);
    const structure = sum((r) => r.b.structure);
    const total = land + structure;
    const buildings = sum((r) => r.b.buildings);
    const tierTotals = [0, 1, 2, 3].map((i) => sum((r) => r.b.tiers[i] ?? 0));
    return {
      title: 'Property value estimate',
      subtitle: `${n0(buildings)} buildings in ${rows.length} barangays`,
      sections: [
        {
          heading: 'City total (estimate)',
          facts: [
            ['Land', `₱${mPeso(land)} M (${pct(land, total)})`],
            ['Structures', `₱${mPeso(structure)} M (${pct(structure, total)})`],
            ['Total', `₱${mPeso(total)} M`],
            ['Mean per building', `₱${n0(total / Math.max(1, buildings))}`],
          ],
        },
        {
          heading: 'By barangay',
          charts: [
            {
              kind: 'donut',
              title: 'City value: land vs structures',
              centerLabel: '₱ total',
              items: [{ label: 'Land', value: land }, { label: 'Structures', value: structure }],
            },
            {
              kind: 'stack',
              title: 'Estimated value, top 15 barangays (₱)',
              series: ['Land', 'Structures'],
              normalize: false,
              rows: rows.slice(0, 15).map((r) => ({ label: r.name, values: [r.b.land, r.b.structure] })),
            },
          ],
          table: {
            columns: ['Barangay', 'Buildings', 'Land ₱M', 'Structures ₱M', 'Total ₱M', 'Mean ₱ per building', 'Street-level match'],
            rows: rows.map(({ name, b, total: t }) => [
              name, b.buildings, mPeso(b.land), mPeso(b.structure), mPeso(t),
              n0(t / Math.max(1, b.buildings)), pct(b.tiers[0] + b.tiers[1], b.buildings),
            ]),
          },
        },
        {
          heading: 'How reliable is the zonal match?',
          charts: [
            {
              kind: 'donut',
              title: 'Buildings by match level',
              centerLabel: 'buildings',
              items: tierTotals.map((v, i) => ({ label: p.tierLabels[i] ?? `Tier ${i + 1}`, value: v })),
            },
          ],
          table: {
            columns: ['Match level', 'Buildings', 'Share'],
            rows: tierTotals
              .map((v, i) => [p.tierLabels[i] ?? `Tier ${i + 1}`, n0(v), pct(v, buildings)])
              .filter((_, i) => tierTotals[i] > 0),
          },
          note: 'Only buildings matched to a named street use that street’s value; the rest use the barangay “all other streets” value.',
        },
      ],
      caveats: [PROPERTY_CAVEAT, p.valuation.costSource, ZONAL_CAVEAT],
    };
  },
};

const terrainReport: ReportDefinition = {
  id: 'terrain-exposure',
  title: 'Flood and surge exposure',
  description: 'Buildings and estimated value reached by modelled storm surge or below 3 m elevation, by barangay.',
  category: 'Terrain',
  build: (ctx): ReportOutput => {
    const p = ctx.property;
    if (!p) return waitingFor('Flood and surge exposure');
    const withData = ctx.analytics.barangays.filter((a) => p.barangays[a.name]).map((a) => ({ a, b: p.barangays[a.name] }));
    const sum = (f: (r: (typeof withData)[number]) => number) => withData.reduce((s, r) => s + f(r), 0);
    const nAll = sum((r) => r.b.withElev);
    const nLow = sum((r) => r.b.lowLying);
    const vLow = sum((r) => r.b.lowLyingValue);
    const vAll = sum((r) => r.b.land + r.b.structure);
    const hasSurge = withData.some((r) => r.b.surge);
    const surgeN = (r: (typeof withData)[number]) => (r.b.surge ? r.b.surge.slice(1).reduce((s, v) => s + v, 0) : 0);
    const surgeV = (r: (typeof withData)[number]) => (r.b.surgeValue ? r.b.surgeValue.slice(1).reduce((s, v) => s + v, 0) : 0);
    const nSurge = sum(surgeN);
    const vSurge = sum(surgeV);
    const byLevel = [1, 2, 3, 4].map((l) => sum((r) => r.b.surge?.[l] ?? 0));
    const labels = p.surgeLabels ?? ['', 'Surge 2-3 m', 'Surge 3-4 m', 'Surge 4-5 m', 'Surge over 5 m'];
    const surgeRows = [...withData].filter((r) => surgeN(r) > 0).sort((x, y) => surgeV(y) - surgeV(x));
    const lowRows = [...withData].filter((r) => r.b.lowLying > 0).sort((x, y) => y.b.lowLyingValue - x.b.lowLyingValue);
    return {
      title: 'Flood and surge exposure',
      subtitle: hasSurge ? `${n0(nSurge)} buildings reached by modelled surge, ${n0(nLow)} below ${p.lowLyingM} m` : `${n0(nLow)} of ${n0(nAll)} buildings below ${p.lowLyingM} m`,
      sections: [
        {
          heading: 'City summary',
          facts: [
            ...(hasSurge
              ? ([
                  ['Reached by any modelled surge (up to over 5 m)', `${n0(nSurge)} buildings (${pct(nSurge, nAll || 1)})`],
                  ['Estimated value in that area', `₱${mPeso(vSurge)} M (${pct(vSurge, vAll)} of total)`],
                ] as Array<[string, string]>)
              : []),
            [`Below ${p.lowLyingM} m elevation`, `${n0(nLow)} buildings (${pct(nLow, nAll)})`],
            ['Estimated value below that elevation', `₱${mPeso(vLow)} M (${pct(vLow, vAll)} of total)`],
            ['City low-lying land share', `${n1(ctx.analytics.citywide.low_lying_pct)}%`],
          ],
        },
        ...(hasSurge
          ? [
              {
                heading: 'Storm surge: buildings by the lowest surge that reaches them',
                charts: [
                  {
                    kind: 'bar',
                    title: 'Buildings by lowest surge band',
                    items: byLevel.map((v, i) => ({ label: labels[i + 1] ?? `Level ${i + 1}`, value: v })),
                  },
                ] as ReportChart[],
                table: {
                  columns: ['Surge band', 'Buildings'],
                  rows: byLevel.map((v, i) => [labels[i + 1] ?? `Level ${i + 1}`, n0(v)]),
                },
                note: 'Surge areas are nested: a building listed under 2-3 m is also reached by every larger surge.',
              },
              {
                heading: 'Storm surge by barangay, most exposed value first',
                charts: [
                  {
                    kind: 'bar',
                    title: 'Value reached by surge, top 15 (₱M)',
                    items: surgeRows.slice(0, 15).map((r) => ({ label: r.a.name, value: surgeV(r) / 1e6 })),
                  },
                  {
                    kind: 'bar',
                    title: 'Share of buildings reached, top 15 (%)',
                    items: [...surgeRows]
                      .sort((x, y) => surgeN(y) / Math.max(1, y.b.buildings) - surgeN(x) / Math.max(1, x.b.buildings))
                      .slice(0, 15)
                      .map((r) => ({ label: r.a.name, value: Math.round((1000 * surgeN(r)) / Math.max(1, r.b.buildings)) / 10, display: pct(surgeN(r), r.b.buildings) })),
                  },
                ] as ReportChart[],
                table: {
                  columns: ['Barangay', 'Buildings reached', 'Share of buildings', 'Reached at 2-3 m', 'Value exposed ₱M'],
                  rows: surgeRows.map((r) => [
                    r.a.name, surgeN(r), pct(surgeN(r), r.b.buildings), r.b.surge?.[1] ?? 0, mPeso(surgeV(r)),
                  ]),
                },
              },
            ]
          : []),
        {
          heading: `Low-lying proxy (below ${p.lowLyingM} m), most exposed value first`,
          charts: [
            {
              kind: 'bar',
              title: `Value below ${p.lowLyingM} m, top 15 (₱M)`,
              items: lowRows.slice(0, 15).map((r) => ({ label: r.a.name, value: r.b.lowLyingValue / 1e6 })),
            },
          ],
          table: {
            columns: ['Barangay', 'Mean elev m', 'Low-lying land %', 'Buildings below', 'Share of buildings', 'Exposed value ₱M'],
            rows: lowRows.map(({ a, b }) => [
              a.name, a.mean_elev_m === null ? '–' : n1(a.mean_elev_m), n1(a.low_lying_pct),
              b.lowLying, pct(b.lowLying, b.withElev), mPeso(b.lowLyingValue),
            ]),
          },
          note: 'Barangays with no buildings below the threshold are omitted.',
        },
      ],
      caveats: [
        'Storm surge: Project NOAH modelled surge advisories (simulations of 721 historical cyclones), ODbL licence. A screening hazard, not a forecast, and it ignores sea walls and drainage.',
        'Project NOAH flood maps (5, 25 and 100-year rain) were checked and do not cover Bacolod City, so river or rain flooding is not shown here. Only the elevation proxy speaks to it.',
        `Elevation comes from a coarse 30 m DEM, so ${p.lowLyingM} m is a screening threshold, not a flood hazard map.`,
        PROPERTY_CAVEAT,
      ],
    };
  },
};

const corridorReport: ReportDefinition = {
  id: 'corridor-comparison',
  needsSim: true,
  title: 'Corridor comparison',
  description: 'Compare two streets (e.g. Burgos vs C.L. Montelibano) on live simulated load, congestion and speed.',
  category: 'Mobility',
  needsCorridors: true,
  build: (ctx): ReportOutput => {
    const snap = ctx.corridors;
    if (!snap) {
      return {
        title: 'Corridor comparison',
        subtitle: 'Simulation data unavailable',
        sections: [{ heading: 'No data', note: 'The simulation data could not be loaded. Check the browser console, or open Simulate.' }],
        caveats: [],
      };
    }
    const byKey = new Map(snap.rows.map((r) => [r.key, r]));
    const a = ctx.corridorA ? byKey.get(ctx.corridorA) : undefined;
    const b = ctx.corridorB ? byKey.get(ctx.corridorB) : undefined;
    const metric = (label: string, f: (r: CorridorRow) => string): Array<string | number | null> => [
      label, a ? f(a) : '–', b ? f(b) : '–',
    ];
    const ranked = snap.rows.filter((r) => r.lengthKm >= 0.3);
    const rankRows = (list: CorridorRow[]) =>
      list.slice(0, 15).map((r) => [r.name, n1(r.lengthKm), n0(r.pcu), n0(r.agents), r.vcMean.toFixed(2), `${Math.round(r.speedRatio * 100)}%`]);
    const cols = ['Street', 'Length km', 'Load (PCU)', 'Agents now', 'Mean v/c', 'Speed vs free flow'];
    return {
      title: 'Corridor comparison',
      subtitle: a && b ? `${a.name} vs ${b.name}` : 'Choose two streets',
      sections: [
        {
          heading: 'Head to head',
          table: {
            columns: ['Measure', a?.name ?? 'Street A', b?.name ?? 'Street B'],
            rows: [
              metric('Length in network', (r) => `${n1(r.lengthKm)} km`),
              metric('Load now (PCU, represented)', (r) => n0(r.pcu)),
              metric('Load per km (PCU)', (r) => n0(r.pcu / Math.max(0.05, r.lengthKm))),
              metric('Simulated agents on street', (r) => n0(r.agents)),
              metric('Mean volume / capacity', (r) => r.vcMean.toFixed(2)),
              metric('Worst segment v/c', (r) => r.vcMax.toFixed(2)),
              metric('Car speed vs free flow', (r) => `${Math.round(r.speedRatio * 100)}%`),
            ],
          },
          note: a && b ? undefined : 'Pick both streets in the panel to compare them.',
        },
        {
          heading: 'Busiest streets (load per km)',
          charts: [
            ...(a && b
              ? ([
                  {
                    kind: 'bar',
                    title: 'Mean volume / capacity',
                    items: [{ label: a.name, value: a.vcMean, display: a.vcMean.toFixed(2) }, { label: b.name, value: b.vcMean, display: b.vcMean.toFixed(2) }],
                  },
                  {
                    kind: 'bar',
                    title: 'Car speed vs free flow (%)',
                    items: [
                      { label: a.name, value: Math.round(a.speedRatio * 100), display: `${Math.round(a.speedRatio * 100)}%` },
                      { label: b.name, value: Math.round(b.speedRatio * 100), display: `${Math.round(b.speedRatio * 100)}%` },
                    ],
                  },
                ] as ReportChart[])
              : []),
            {
              kind: 'bar',
              title: 'Load per km (PCU), top 10',
              items: [...ranked].sort((x, y) => y.pcu / y.lengthKm - x.pcu / x.lengthKm).slice(0, 10).map((r) => ({ label: r.name, value: Math.round(r.pcu / r.lengthKm) })),
            },
            {
              kind: 'bar',
              title: 'Mean v/c, 10 most congested',
              items: [...ranked].sort((x, y) => y.vcMean - x.vcMean).slice(0, 10).map((r) => ({ label: r.name, value: r.vcMean, display: r.vcMean.toFixed(2) })),
            },
          ] as ReportChart[],
          table: {
            columns: cols,
            rows: rankRows([...ranked].sort((x, y) => y.pcu / y.lengthKm - x.pcu / x.lengthKm)),
          },
          note: 'Streets with at least 0.3 km in the network.',
        },
        {
          heading: 'Most congested streets (mean v/c)',
          table: { columns: cols, rows: rankRows([...ranked].sort((x, y) => y.vcMean - x.vcMean)) },
        },
      ],
      caveats: [
        'A snapshot of the running simulation, smoothed over about a sim minute, not an average over the day. Compare at the same clock time and let it run a few minutes first.',
        'Demand is synthetic (gravity model) and not calibrated to Bacolod traffic counts, which we do not have.',
        'Streets are named by matching network edges to OSM roads within 25 m; about two thirds of edges are unnamed minor roads and are not counted here.',
      ],
    };
  },
};

const tripGenReport: ReportDefinition = {
  id: 'trip-generation',
  needsSim: true,
  title: 'Trip generation by building',
  description: 'Trips produced and attracted by each building, campus and land use in the running simulation.',
  category: 'Mobility',
  needsTripTally: true,
  build: (ctx): ReportOutput => {
    const g = ctx.tripGen;
    if (!g) {
      return {
        title: 'Trip generation by building',
        subtitle: 'Simulation data unavailable',
        sections: [{ heading: 'No data', note: 'The simulation data could not be loaded. Check the browser console, or open Simulate.' }],
        caveats: [],
      };
    }
    const pair = (o: number, d: number) => [n0(o), n0(d)];
    const bRow = (r: BuildingTripRow) => [r.name, r.bclass, r.zone, ...pair(r.out, r.in), n0(r.outScaled), n0(r.inScaled)];
    const bCols = ['Building', 'Class', 'Barangay', 'Trips out', 'Trips in', 'Out (city-scaled)', 'In (city-scaled)'];
    return {
      title: 'Trip generation by building',
      subtitle: `${n0(g.totalTrips)} simulated trips over ${n1(g.simHours)} sim hours`,
      sections: [
        {
          heading: 'By land use',
          charts: [
            { kind: 'donut', title: 'Trips in, by land use', centerLabel: 'trips in', items: g.landUse.map((l) => ({ label: l.group, value: l.in })) },
            { kind: 'donut', title: 'Trips out, by land use', centerLabel: 'trips out', items: g.landUse.map((l) => ({ label: l.group, value: l.out })) },
          ],
          table: {
            columns: ['Land use', 'Buildings', 'Trips out', 'Trips in', 'Out (city-scaled)', 'In (city-scaled)', 'Trips in per building'],
            rows: g.landUse.map((l) => [
              l.group, n0(l.buildings), ...pair(l.out, l.in), n0(l.outScaled), n0(l.inScaled),
              (l.in / Math.max(1, l.buildings)).toFixed(2),
            ]),
          },
          note: 'Out = trips that start in the building, in = trips that end there. A home-to-work trip counts once out of the home and once in at the workplace.',
        },
        {
          heading: 'Campuses and institutions',
          charts: [{ kind: 'bar', title: 'Trips in, top 12 campuses', items: g.campuses.slice(0, 12).map((c) => ({ label: c.name, value: c.in })) }],
          table: {
            columns: ['Campus', 'Type', 'Buildings', 'Trips out', 'Trips in', 'Out (city-scaled)', 'In (city-scaled)'],
            rows: g.campuses.slice(0, 40).map((c) => [c.name, c.group, n0(c.buildings), ...pair(c.out, c.in), n0(c.outScaled), n0(c.inScaled)]),
          },
          note: 'Same-named schools, hospitals and civic buildings are grouped into one campus. Top 40 by trips in.',
        },
        {
          heading: 'Top attractors (trips in)',
          charts: [{ kind: 'bar', title: 'Trips in, top 10 buildings', items: g.topAttractors.slice(0, 10).map((r) => ({ label: r.name, value: r.in })) }],
          table: { columns: bCols, rows: g.topAttractors.map(bRow) },
        },
        {
          heading: 'Top producers (trips out)',
          charts: [{ kind: 'bar', title: 'Trips out, top 10 buildings', items: g.topProducers.slice(0, 10).map((r) => ({ label: r.name, value: r.out })) }],
          table: { columns: bCols, rows: g.topProducers.map(bRow) },
        },
      ],
      caveats: [
        'Counts are simulated agents. “City-scaled” multiplies each by how many real trips the sampled agent stands for when it is spawned; it is an estimate, not a count.',
        'Counts start when the simulation starts or you reset them; run through a full day for daily totals.',
        'Building choice follows the gravity model and building role weights, so counts reflect modelled demand, not surveyed trips.',
      ],
    };
  },
};

const purposeReport: ReportDefinition = {
  id: 'trip-purpose',
  title: 'Trip purpose by barangay',
  description: 'Expected work / school / other mix of residents’ trips, from age structure and survey trip rates.',
  category: 'Mobility',
  build: (ctx): ReportOutput => {
    const pm = ctx.purposeMix;
    if (!pm) {
      return {
        title: 'Trip purpose by barangay',
        subtitle: 'Loading data…',
        sections: [{ heading: 'Loading', note: 'Demographic data is still loading.' }],
        caveats: [],
      };
    }
    const names = Object.keys(pm.demand.barangays);
    const row = (name: string) => {
      const d = pm.demand.barangays[name];
      const demo = pm.demographics.barangays[name];
      const ty = pm.typology?.barangays[name];
      const pop = demo?.population ?? d.population;
      return {
        name,
        type: ty?.label ?? '–',
        pop,
        young: demo ? (demo.age_5_14 + demo.age_15_24) / pop : 0,
        old: demo ? demo.age_60_plus / pop : 0,
        work: d.mix.hbw,
        school: d.mix.hbe,
        other: d.mix.hbo,
      };
    };
    const rows = names.map(row).sort((a, b) => b.school - a.school);
    const byType = new Map<string, typeof rows>();
    for (const r of rows) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
    const avg = (list: typeof rows, f: (r: (typeof rows)[number]) => number) =>
      list.reduce((s, r) => s + f(r) * r.pop, 0) / Math.max(1, list.reduce((s, r) => s + r.pop, 0));
    const p = (v: number) => `${(v * 100).toFixed(1)}%`;
    const cs = pm.demand.meta.cityShares;
    return {
      title: 'Trip purpose by barangay',
      subtitle: `City mix: work ${p(cs.hbw)}, school ${p(cs.hbe)}, other ${p(cs.hbo)}`,
      sections: [
        {
          heading: 'By area type (population-weighted)',
          charts: [
            {
              kind: 'stack',
              title: 'Trip purpose mix by area type',
              series: ['Work', 'School', 'Other'],
              normalize: true,
              rows: [
                ...[...byType.entries()].map(([type, list]) => ({
                  label: type,
                  values: [avg(list, (r) => r.work), avg(list, (r) => r.school), avg(list, (r) => r.other)],
                })),
                { label: 'City', values: [cs.hbw, cs.hbe, cs.hbo] },
              ],
            },
            {
              kind: 'scatter',
              title: 'Young residents vs school trip share',
              xLabel: 'Aged 5-24 (% of residents)',
              yLabel: 'School share of trips (%)',
              points: rows.map((r) => ({ label: r.name, x: Math.round(r.young * 1000) / 10, y: Math.round(r.school * 1000) / 10 })),
              note: 'Each dot is one barangay.',
            },
          ],
          table: {
            columns: ['Area type', 'Barangays', 'Residents', 'Work', 'School', 'Other', 'Aged 5-24', 'Aged 60+'],
            rows: [...byType.entries()].map(([type, list]) => [
              type, list.length, n0(list.reduce((s, r) => s + r.pop, 0)),
              p(avg(list, (r) => r.work)), p(avg(list, (r) => r.school)), p(avg(list, (r) => r.other)),
              p(avg(list, (r) => r.young)), p(avg(list, (r) => r.old)),
            ]),
          },
        },
        {
          heading: 'By barangay (highest school share first)',
          charts: [
            {
              kind: 'stack',
              title: 'Purpose mix, 12 highest and lowest school share',
              series: ['Work', 'School', 'Other'],
              normalize: true,
              rows: [...rows.slice(0, 6), ...rows.slice(-6)].map((r) => ({ label: r.name, values: [r.work, r.school, r.other] })),
            },
          ],
          table: {
            columns: ['Barangay', 'Area type', 'Residents', 'Aged 5-24', 'Aged 60+', 'Work', 'School', 'Other'],
            rows: rows.map((r) => [r.name, r.type, n0(r.pop), p(r.young), p(r.old), p(r.work), p(r.school), p(r.other)]),
          },
        },
        {
          heading: 'Method',
          facts: [
            ...Object.entries(pm.demand.meta.tripRates).map(([k, v]): [string, string] => [`Trips/day, ${k.replace('age_', '').replace('_', '-')}`, String(v)]),
          ],
          note: 'Trips = residents in each age band x survey trip rate, split to purposes by an assumed age-to-purpose matrix, then scaled so city totals match the model mix. Area types come from a clustering of urban form, POIs, jobs and age structure.',
        },
      ],
      caveats: [
        'Trip rates are from the JICA Metro Cebu 2014 household survey (not Bacolod). The survey gives no purpose split by age; the matrix is an assumption.',
        'Age data: PSA 2020 Census of Population and Housing via HDX (CC BY). Mix describes residents’ trips; commuting inflows are handled by the gravity model, not here.',
        'Area types are an unvalidated grouping (the TSSP 2023 study reports 41 urban and 20 suburban barangays).',
      ],
    };
  },
};

export const REPORTS: ReportDefinition[] = [
  citySnapshot,
  barangayProfile,
  ranking,
  businessReport,
  dataQuality,
  mobilityReport,
  corridorReport,
  tripGenReport,
  purposeReport,
  propertyReport,
  terrainReport,
];
