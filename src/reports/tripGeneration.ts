/** Trips produced and attracted per building, rolled up by land use and by campus / institution. */
import type { MobilityBuildings } from '../utils/mobilityTypes';
import type { TripTally } from '../utils/mobilitySim';

export type LandUseGroup =
  | 'Residential'
  | 'Commercial'
  | 'Education'
  | 'Health'
  | 'Civic & religious'
  | 'Industrial'
  | 'Other';

const GROUPS: Record<string, LandUseGroup> = {
  house: 'Residential', apartments: 'Residential', residential: 'Residential', dormitory: 'Residential',
  terrace: 'Residential', roof: 'Residential',
  commercial: 'Commercial', retail: 'Commercial', supermarket: 'Commercial', hotel: 'Commercial',
  office: 'Commercial', mixed_use: 'Commercial',
  school: 'Education', college: 'Education', university: 'Education',
  healthcare: 'Health', hospital: 'Health',
  civic: 'Civic & religious', government: 'Civic & religious', public: 'Civic & religious',
  library: 'Civic & religious', post_office: 'Civic & religious', church: 'Civic & religious',
  chapel: 'Civic & religious', cathedral: 'Civic & religious', mosque: 'Civic & religious',
  temple: 'Civic & religious', religious: 'Civic & religious', grandstand: 'Civic & religious',
  industrial: 'Industrial', warehouse: 'Industrial',
};

/** Classes whose same-named buildings form one campus (chains such as 7-Eleven are not campuses). */
const CAMPUS_GROUPS = new Set<LandUseGroup>(['Education', 'Health', 'Civic & religious']);

export function landUseOfClass(cls: string): LandUseGroup {
  return GROUPS[cls] ?? 'Other';
}

export interface BuildingTripRow {
  index: number;
  name: string;
  bclass: string;
  zone: string;
  out: number;
  in: number;
  outScaled: number;
  inScaled: number;
}

export interface LandUseTripRow {
  group: LandUseGroup;
  buildings: number;
  out: number;
  in: number;
  outScaled: number;
  inScaled: number;
}

export interface CampusTripRow {
  name: string;
  group: LandUseGroup;
  buildings: number;
  out: number;
  in: number;
  outScaled: number;
  inScaled: number;
}

export interface TripGenSnapshot {
  totalTrips: number;
  totalScaled: number;
  simHours: number;
  topAttractors: BuildingTripRow[];
  topProducers: BuildingTripRow[];
  landUse: LandUseTripRow[];
  campuses: CampusTripRow[];
}

export function aggregateTripGeneration(
  bt: MobilityBuildings,
  zoneNames: string[],
  tally: TripTally,
  topN = 25
): TripGenSnapshot {
  const n = bt.count;
  const zoneOf = new Uint16Array(n);
  for (let z = 0; z < zoneNames.length; z += 1) {
    for (let i = bt.zoneOffs[z]; i < bt.zoneOffs[z + 1]; i += 1) zoneOf[i] = z;
  }

  const lu = new Map<LandUseGroup, LandUseTripRow>();
  const campus = new Map<string, CampusTripRow>();
  const rows: BuildingTripRow[] = [];
  let totalTrips = 0;
  let totalScaled = 0;

  for (let i = 0; i < n; i += 1) {
    const o = tally.out[i];
    const d = tally.in[i];
    const group = landUseOfClass(bt.classes[bt.cls[i]] ?? 'unknown');
    let l = lu.get(group);
    if (!l) {
      l = { group, buildings: 0, out: 0, in: 0, outScaled: 0, inScaled: 0 };
      lu.set(group, l);
    }
    l.buildings += 1;
    l.out += o;
    l.in += d;
    l.outScaled += tally.outScaled[i];
    l.inScaled += tally.inScaled[i];
    totalTrips += o;
    totalScaled += tally.outScaled[i];

    const name = bt.named[String(i)]?.[1] ?? '';
    if (name && CAMPUS_GROUPS.has(group)) {
      const key = `${group}|${name}`;
      let c = campus.get(key);
      if (!c) {
        c = { name, group, buildings: 0, out: 0, in: 0, outScaled: 0, inScaled: 0 };
        campus.set(key, c);
      }
      c.buildings += 1;
      c.out += o;
      c.in += d;
      c.outScaled += tally.outScaled[i];
      c.inScaled += tally.inScaled[i];
    }
    if (o + d > 0) {
      rows.push({
        index: i, name: name || '(unnamed)', bclass: bt.classes[bt.cls[i]] ?? 'unknown',
        zone: zoneNames[zoneOf[i]] ?? '', out: o, in: d,
        outScaled: tally.outScaled[i], inScaled: tally.inScaled[i],
      });
    }
  }

  return {
    totalTrips,
    totalScaled,
    simHours: tally.simSec / 3600,
    topAttractors: [...rows].sort((a, b) => b.in - a.in).slice(0, topN),
    topProducers: [...rows].sort((a, b) => b.out - a.out).slice(0, topN),
    landUse: [...lu.values()].sort((a, b) => b.in + b.out - (a.in + a.out)),
    campuses: [...campus.values()].filter((c) => c.in + c.out > 0).sort((a, b) => b.in - a.in),
  };
}

/** GERS id (lower-case hex, no dashes) -> building row, for looking up a selected map building. */
export function buildGersIndex(bt: MobilityBuildings): Map<string, number> {
  const m = new Map<string, number>();
  if (!bt.gersIds) return m;
  const hex: string[] = [];
  for (let b = 0; b < 256; b += 1) hex.push(b.toString(16).padStart(2, '0'));
  for (let i = 0; i < bt.count; i += 1) {
    let s = '';
    for (let k = 0; k < 16; k += 1) s += hex[bt.gersIds[i * 16 + k]];
    m.set(s, i);
  }
  return m;
}

export function gersKey(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}
