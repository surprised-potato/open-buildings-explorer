export type MobilityModeId = 'walk' | 'motorcycle' | 'tricycle' | 'car' | 'puv';

export type MobilityPurposeId = 'hbw' | 'hbe' | 'hbo';

export type MobilityRole = 'home' | 'work' | 'school' | 'other';

export type MobilityBarangayFilter = 'all' | 'from' | 'to' | 'both';

export type MobilityColorMode = 'mode' | 'speed';

export type MobilityPhaseLabel = 'AM Rush' | 'Midday' | 'PM Rush' | 'Night';

export interface MobilityModeMeta {
  id: MobilityModeId;
  name: string;
  color: [number, number, number];
  asc: number;
  beta_cost: number;
  beta_duration: number;
  cost_per_km: number;
  target_share: number;
  occupancy_min?: number;
  occupancy_max?: number;
  pcu?: number;
  congests?: boolean;
  lane_filter?: number;
}

export interface MobilityPurposeMeta {
  name: string;
  share: number;
  beta: number;
  attr: 'jobs' | 'students' | 'commerce' | string;
}

export interface MobilityZoneMeta {
  idx: number;
  id: string;
  name: string;
  centroid: [number, number];
  hub_node: number;
  pop: number;
  jobs: number;
  students: number;
  commerce: number;
  access_nodes: Record<MobilityRole, Array<[number, number]>>;
  access_spurs: Record<string, [number[], number[], number[]]>;
  /** Nearest-neighbour road distance to another zone hub, km (intrazonal distance basis). */
  nn_km?: number;
  /** Trips/day produced by residents per purpose (PSA age bands x survey rates); absent in older files. */
  prod?: Record<MobilityPurposeId, number>;
  /** Purpose shares of this zone's production (sums to 1). */
  purpose_mix?: Record<MobilityPurposeId, number>;
  /** Area type from scripts/classify_barangays.py. */
  area_type?: { key: string; label: string };
  /** Summed building role weights (home/work/school/other) from the building table. */
  bldg_attr?: Record<MobilityRole, number>;
  /** Weight-averaged building centroid per role [lon, lat]. */
  bldg_centroid?: Partial<Record<MobilityRole, [number, number]>>;
}

export interface MobilitySkims {
  /** Hub-to-hub road distance (km), motorized profile; -1 when unreachable. */
  od_km: number[][];
  /** Hub-to-hub free-flow car time (minutes). */
  od_min: number[][];
  od_walk_km: number[][];
}

export interface MobilityZonesMetadata {
  generated_at: string;
  source: string;
  n_nodes: number;
  n_edges: number;
  n_pts: number;
  modes: MobilityModeMeta[];
  purposes: Record<MobilityPurposeId, MobilityPurposeMeta>;
  routing_profiles: string[];
  mode_profile_map: Record<MobilityModeId, number>;
  zones: MobilityZoneMeta[];
  skims?: MobilitySkims;
  /** Survey-derived anchors used to size the concurrent peak-hour traveller count. */
  demand?: { population: number; trips_per_person: number; peak_share: number };
}

export interface MobilitySimStats {
  activeAgents: number;
  targetAgents: number;
  totalTravellers: number;
  phaseLabel: MobilityPhaseLabel;
  modeCounts: Record<MobilityModeId, number>;
  modeTravellers: Record<MobilityModeId, number>;
  purposeCounts: Record<MobilityPurposeId, number>;
  avgTripMin: number;
  /** Mean route length of active trips, km. */
  avgTripKm: number;
  /** Wall-clock cost of the last sim step (ms) and trips spawned in it. */
  stepMs: number;
  spawnsPerStep: number;
  /** Share (0-1) of active trips that start and end in the same barangay. */
  intraZoneShare: number;
  avgSpeedRatio: number;
  travelTimeIndex: number;
  congestedEdgeCount: number;
  peakVcRatio: number;
  selectedBarangayOutbound: number;
  /** Purposes of active trips whose home end is in the selected barangay (residents' trips). */
  selectedBarangayPurposes: Record<MobilityPurposeId, number>;
  selectedBarangayInbound: number;
  loaded: boolean;
}

export interface SelectedAgentInfo {
  agentId: number;
  originZone: string;
  destZone: string;
  purpose: MobilityPurposeId;
  purposeLabel: string;
  mode: MobilityModeId;
  modeLabel: string;
  passengers: number;
  pcu: number;
  freeFlowSpeedKmh: number;
  speedKmh: number;
  currentLinkVc: number;
  channel: 'carriageway' | 'sidewalk';
  distanceKm: number;
  durationMin: number;
  progressPct: number;
  etaMin: number;
  coordinates: [number, number];
  routePath: [number, number, number][];
  /** Monotonic id of the trip occupying this slot; changes when the agent respawns. */
  tripSerial: number;
  /** Real-world vehicles each simulated dot stands for (sampling factor). */
  sampleScale: number;
  /** Real travellers this dot stands for = passengers * sampleScale. */
  representedTravellers: number;
  departHours: number;
  /** Simulated minutes since departure (wall clock of the sim). */
  elapsedMin: number;
  /** Elapsed minus free-flow elapsed, minutes (>= 0). */
  delayMin: number;
  distanceTravelledKm: number;
  distanceRemainingKm: number;
  linkIndex: number;
  linkCount: number;
  originCoords: [number, number];
  destCoords: [number, number];
  originBuilding: MobilityBuildingRef | null;
  destBuilding: MobilityBuildingRef | null;
}

export interface CongestedEdgeSegment {
  path: [number, number, number][];
  vc: number;
}

export const BUILDING_WEIGHT_SCALE = 64;
export const MOBILITY_BUILDINGS_MAGIC = 0x444c4242; // 'BBLD'

export interface MobilityBuildings {
  count: number;
  /** Start index of each zone's buildings (length nZones + 1). Buildings are sorted by zone. */
  zoneOffs: Uint32Array;
  lon: Float32Array;
  lat: Float32Array;
  areaM2: Float32Array;
  /** Nearest road node used as the building's access point. */
  node: Uint16Array;
  cls: Uint8Array;
  classes: string[];
  /** Role weights: [home, work, school, other], fixed point x BUILDING_WEIGHT_SCALE. */
  weights: [Uint16Array, Uint16Array, Uint16Array, Uint16Array];
  /** Next edge toward each zone hub for any node: (profile * nZones + zone) * nNodes + node. */
  toHubNextEdge: Uint16Array;
  /** 16 raw UUID bytes per building (GERS id); absent in older files. */
  gersIds?: Uint8Array;
  /** Row index -> [GERS id, name] for buildings with a known name. */
  named: Record<string, [string, string]>;
}

export interface MobilityBuildingRef {
  index: number;
  role: MobilityRole;
  lon: number;
  lat: number;
  bclass: string;
  areaM2: number;
  name: string | null;
  id: string | null;
  /** Straight-line distance from the building to its road access node, metres. */
  accessM: number;
}

export interface MobilityDataset {
  meta: MobilityZonesMetadata;
  nNodes: number;
  nEdges: number;
  nPts: number;
  nZones: number;
  nProfiles: number;
  nodeLon: Float32Array;
  nodeLat: Float32Array;
  nodeElev: Float32Array;
  edgeSrc: Uint16Array;
  edgeDst: Uint16Array;
  edgeLenKm: Float32Array;
  edgeCapacity: Float32Array;
  edgeT0Sec: Float32Array;
  geomOffs: Uint32Array;
  geomCoords: Float32Array;
  fromHubPrevEdge: Uint16Array;
  ptCumFrac: Float32Array;
  /** Optional building-level origin/destination table (mobility_buildings.bin). */
  buildings?: MobilityBuildings;
}

export interface MobilitySimParams {
  targetAgents: number;
  betaScale: number;
  enabledModes: Record<MobilityModeId, boolean>;
  selectedBarangayName: string | null;
  barangayFilter: MobilityBarangayFilter;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  opacity: number;
  congestionEnabled?: boolean;
  congestionLoadScale?: number;
  colorMode?: MobilityColorMode;
  /** Exponential deterrence length (km) in f(d)=d^-beta*exp(-d/lambda). */
  gravityLambdaKm?: number;
  /** 0 = zone totals only, 1 = building-derived attractions only. */
  attrBlend?: number;
  /** Exponent on the doubly-constrained balancing factors: 0 = singly constrained, 1 = fully balanced. */
  gravityBalance?: number;
}

export interface MobilityRenderSlice {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
  radii: Float32Array;
}

export interface MobilityDiurnalState {
  intensity: number;
  paShare: Record<MobilityPurposeId, number>;
  phaseLabel: MobilityPhaseLabel;
}

export const MOBILITY_MODES_ORDER: readonly MobilityModeId[] = [
  'walk',
  'motorcycle',
  'tricycle',
  'car',
  'puv',
] as const;

export const MOBILITY_MODE_COLORS: Record<MobilityModeId, [number, number, number]> = {
  walk: [248, 250, 252],
  motorcycle: [236, 72, 153],
  tricycle: [16, 185, 129],
  car: [56, 189, 248],
  puv: [245, 158, 11],
};

export const MOBILITY_MODE_HEX: Record<MobilityModeId, string> = {
  walk: '#f8fafc',
  motorcycle: '#ec4899',
  tricycle: '#10b981',
  car: '#38bdf8',
  puv: '#f59e0b',
};

export const MOBILITY_MODE_LABELS: Record<MobilityModeId, string> = {
  walk: 'Walk',
  motorcycle: 'Motorcycle',
  tricycle: 'Tricycle',
  car: 'Car',
  puv: 'Jeepney / bus',
};

export const MOBILITY_PURPOSE_LABELS: Record<MobilityPurposeId, string> = {
  hbw: 'Home–Work',
  hbe: 'Home–School',
  hbo: 'Home–Other',
};

export function createEmptyMobilityStats(): MobilitySimStats {
  return {
    activeAgents: 0,
    targetAgents: 15000,
    totalTravellers: 0,
    phaseLabel: 'AM Rush',
    modeCounts: {
      walk: 0,
      motorcycle: 0,
      tricycle: 0,
      car: 0,
      puv: 0,
    },
    modeTravellers: {
      walk: 0,
      motorcycle: 0,
      tricycle: 0,
      car: 0,
      puv: 0,
    },
    purposeCounts: {
      hbw: 0,
      hbe: 0,
      hbo: 0,
    },
    avgTripMin: 0,
    avgTripKm: 0,
    stepMs: 0,
    spawnsPerStep: 0,
    intraZoneShare: 0,
    avgSpeedRatio: 1,
    travelTimeIndex: 1,
    congestedEdgeCount: 0,
    peakVcRatio: 0,
    selectedBarangayOutbound: 0,
    selectedBarangayPurposes: { hbw: 0, hbe: 0, hbo: 0 },
    selectedBarangayInbound: 0,
    loaded: false,
  };
}
