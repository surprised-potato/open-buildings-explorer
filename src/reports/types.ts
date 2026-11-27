import type {
  BarangayAnalyticsDataset,
  BuildingPoiRecord,
} from '../layers/types';
import type { MobilitySimStats } from '../utils/mobilityTypes';
import type { CorridorSnapshot } from './corridors';
import type { TripGenSnapshot } from './tripGeneration';

export interface ReportTable {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface ReportSection {
  heading: string;
  /** Label / value pairs shown as a compact list. */
  facts?: Array<[string, string]>;
  table?: ReportTable;
  note?: string;
}

export interface ReportOutput {
  title: string;
  subtitle: string;
  sections: ReportSection[];
  /** Caveats printed at the end of every report. */
  caveats: string[];
}

/** Per-barangay property estimates (public/data/bacolod/barangay_property.json). */
export interface BarangayPropertyEntry {
  buildings: number;
  footprintM2: number;
  land: number;
  structure: number;
  byGroup: Record<string, { buildings: number; total: number }>;
  tiers: number[];
  lowLying: number;
  lowLyingValue: number;
  withElev: number;
  /** Buildings (and PHP value) by lowest storm-surge advisory that reaches them: [none, SSA1..SSA4]. */
  surge?: number[];
  surgeValue?: number[];
}

export interface PropertyData {
  valuation: { note: string; costSource: string };
  lowLyingM: number;
  tierLabels: string[];
  surgeLabels?: string[];
  barangays: Record<string, BarangayPropertyEntry>;
}

/** Age-based trip purpose model and barangay typology (barangay_demand / _demographics / _typology). */
export interface PurposeMixData {
  demand: {
    meta: { tripRates: Record<string, number>; purposeMatrix: Record<string, Record<string, number>>; cityShares: Record<string, number> };
    barangays: Record<string, { population: number; prod: Record<string, number>; mix: Record<string, number> }>;
  };
  demographics: {
    barangays: Record<string, { population: number; age_0_4: number; age_5_14: number; age_15_24: number; age_25_59: number; age_60_plus: number }>;
  };
  typology: { barangays: Record<string, { type: string; label: string }> } | null;
}

export interface ReportContext {
  /** Null until the age-based purpose model files have loaded. */
  purposeMix: PurposeMixData | null;
  /** Live per-building trip generation roll-up; null when the simulation is unavailable. */
  tripGen: TripGenSnapshot | null;
  /** Live street-level simulation roll-up; null when the simulation or street names are unavailable. */
  corridors: CorridorSnapshot | null;
  /** Street keys chosen for the corridor comparison (see corridors.streetKey). */
  corridorA: string | null;
  corridorB: string | null;
  /** Null until barangay_property.json has loaded. */
  property: PropertyData | null;
  analytics: BarangayAnalyticsDataset;
  pois: Record<string, BuildingPoiRecord>;
  barangay: string | null;
  mobilityStats: MobilitySimStats | null;
  /** Counts per zonal estimate tier (building_zonal.json), when loaded. */
  zonalTierCounts: number[] | null;
  zonalTierLabels: string[] | null;
}

export type ReportCategory = 'City' | 'Barangay' | 'Business' | 'Quality' | 'Mobility' | 'Property' | 'Terrain';

export interface ReportDefinition {
  id: string;
  title: string;
  description: string;
  category: ReportCategory;
  /** True when the report needs a barangay selected. */
  needsBarangay?: boolean;
  /** True when the report compares two streets chosen in the panel. */
  needsCorridors?: boolean;
  /** True when the report reads the live per-building trip tally (panel offers a reset button). */
  needsTripTally?: boolean;
  /** True when the report reads the mobility simulation (live, or the background run when none is open). */
  needsSim?: boolean;
  build: (ctx: ReportContext) => ReportOutput;
}
