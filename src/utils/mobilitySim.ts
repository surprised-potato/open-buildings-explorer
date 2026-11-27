import { TreeSolver, buildOutAdjacency } from './routeTrees';
import { buildingGersId } from './mobilityLoader';
import {
  BUILDING_WEIGHT_SCALE,
  MOBILITY_MODES_ORDER,
  MOBILITY_MODE_COLORS,
  MOBILITY_MODE_LABELS,
  MOBILITY_PURPOSE_LABELS,
  type CongestedEdgeSegment,
  type MobilityBuildingRef,
  type MobilityDataset,
  type MobilityDiurnalState,
  type MobilityModeId,
  type MobilityPhaseLabel,
  type MobilityPurposeId,
  type MobilityRenderSlice,
  type MobilityRole,
  type MobilitySimParams,
  type MobilitySimStats,
  type MobilityZoneMeta,
  type MobilityZonesMetadata,
  type SelectedAgentInfo,
} from './mobilityTypes';

export const MAX_AGENTS = 25000;
const INVALID_EDGE = 0xffff;
const FURNESS_ITERS = 20;
const MIN_GRAVITY_DIST_KM = 0.5;
const ROLE_INDEX: Record<MobilityRole, number> = { home: 0, work: 1, school: 2, other: 3 };
const ROLES: readonly MobilityRole[] = ['home', 'work', 'school', 'other'] as const;
const DEFAULT_LAMBDA_KM = 3;
const DEFAULT_ATTR_BLEND = 0.5;
const DEFAULT_BALANCE = 0.5;
const INTRAZONAL_MIN_KM = 0.3;
const K_ALTERNATIVES = 8;
const WALK_MAX_STRAIGHT_KM = 5;
const TRICYCLE_MAX_STRAIGHT_KM = 9;
const CONGESTION_EVERY_N_STEPS = 3;
/** One destination tree is re-solved on live congested times every this many steps. */
const REROUTE_EVERY_N_STEPS = 6;
/**
 * Each destination keeps this many route trees, solved on differently perturbed edge costs, and a
 * trip picks one at random. Near-equal corridors (e.g. Burgos vs C.L. Montelibano) then share
 * traffic instead of the marginally cheaper one taking all of it.
 */
const ROUTE_VARIANTS = 3;
/** Std-dev of the log-normal per-edge cost perturbation (about +/-25 %). */
const ROUTE_NOISE_SIGMA = 0.25;
/** Car edge times at or above this (s) are banned edges and never traversed. */
const BANNED_EDGE_SEC = 1e6;
const DEG_KM_LAT = 110.574;
const DEG_KM_LON_AT_EQ = 111.32;

/** Gravity impedance f(d) = d^-beta * exp(-d/lambda). */
function impedance(dKm: number, beta: number, lambdaKm: number): number {
  const d = Math.max(0.05, dKm);
  return Math.pow(d, -beta) * Math.exp(-d / lambdaKm);
}

interface GravityModel {
  key: string;
  /** Per purpose: cumulative production distribution over zones (age-based when available). */
  prodCdf: Record<MobilityPurposeId, Float64Array>;
  /** Per purpose: balancing factor b_j * attraction A_j per zone. */
  zoneWeight: Record<MobilityPurposeId, Float64Array>;
  beta: Record<MobilityPurposeId, number>;
  lambdaKm: number;
  /** Median road/straight-line distance ratio from the skims. */
  circuity: number;
  /** Zone building centroids per role: [home, work, school, other] x (lon,lat) arrays. */
  cLon: Float64Array[];
  cLat: Float64Array[];
}

const PURPOSE_IDS: readonly MobilityPurposeId[] = ['hbw', 'hbe', 'hbo'] as const;
const CONGESTION_SMOOTH_TAU_SEC = 4.0;
const BPR_ALPHA = 0.15;
const MAX_BPR_MULT = 8.0;
const SIDEWALK_OFFSET_M = 2.0;
/** Height of particles above the ground surface (just enough to avoid flickering into the terrain). */
const PARTICLE_LIFT_M = 1.0;
/** Height of route / congestion lines above the ground surface. */
const PATH_LIFT_M = 0.8;
const CONCURRENT_CITY_PEOPLE_PEAK = 32000;
/** Tunable congestion calibration (edge storage multiplier on capacity*t0/3600). */
export const CONGESTION_TUNING = { critScale: 3.0 };

const MODE_BASE_RADIUS: readonly number[] = [
  1.9, // walk (compact sidewalk dot)
  2.5, // motorcycle
  2.6, // tricycle
  3.0, // car
  4.2, // puv (15-20 passenger jeepney)
];

const DEFAULT_MODE_PHYSICS: ReadonlyArray<{
  occMin: number;
  occMax: number;
  pcu: number;
  congests: boolean;
  laneFilter: number;
}> = [
  { occMin: 1, occMax: 1, pcu: 0.0, congests: false, laneFilter: 0.0 }, // walk
  { occMin: 1, occMax: 2, pcu: 0.4, congests: true, laneFilter: 0.65 }, // motorcycle
  { occMin: 1, occMax: 4, pcu: 0.6, congests: true, laneFilter: 1.0 }, // tricycle
  { occMin: 1, occMax: 3, pcu: 1.0, congests: true, laneFilter: 1.0 }, // car
  { occMin: 15, occMax: 20, pcu: 2.0, congests: true, laneFilter: 1.0 }, // puv
];

interface DiurnalKnot {
  hour: number;
  hbw: number;
  hbe: number;
  hbo: number;
}

const DIURNAL_KNOTS: readonly DiurnalKnot[] = [
  { hour: 0.0, hbw: 0.32, hbe: 0.30, hbo: 0.42 },
  { hour: 5.0, hbw: 0.55, hbe: 0.60, hbo: 0.50 },
  { hour: 7.5, hbw: 0.85, hbe: 0.88, hbo: 0.55 },
  { hour: 10.5, hbw: 0.68, hbe: 0.70, hbo: 0.52 },
  { hour: 12.5, hbw: 0.50, hbe: 0.50, hbo: 0.50 },
  { hour: 15.0, hbw: 0.32, hbe: 0.28, hbo: 0.48 },
  { hour: 17.5, hbw: 0.15, hbe: 0.12, hbo: 0.45 },
  { hour: 20.5, hbw: 0.20, hbe: 0.16, hbo: 0.42 },
  { hour: 22.0, hbw: 0.25, hbe: 0.22, hbo: 0.42 },
  { hour: 24.0, hbw: 0.32, hbe: 0.30, hbo: 0.42 },
];

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Compute 24-hour Bacolod diurnal demand intensity, production->attraction share,
 * and rush/off-peak phase label.
 */
export function getDiurnalState(timeHours: number): MobilityDiurnalState {
  const h = ((timeHours % 24) + 24) % 24;

  const amPeak = Math.exp(-0.5 * ((h - 7.5) / 1.45) ** 2);
  const midPeak = Math.exp(-0.5 * ((h - 12.5) / 1.8) ** 2);
  const pmPeak = Math.exp(-0.5 * ((h - 17.5) / 1.65) ** 2);
  const intensity = Math.max(
    0.08,
    Math.min(1.0, 0.1 + 0.88 * amPeak + 0.45 * midPeak + 0.85 * pmPeak)
  );

  let k0 = DIURNAL_KNOTS[0];
  let k1 = DIURNAL_KNOTS[DIURNAL_KNOTS.length - 1];
  for (let i = 0; i < DIURNAL_KNOTS.length - 1; i += 1) {
    if (h >= DIURNAL_KNOTS[i].hour && h <= DIURNAL_KNOTS[i + 1].hour) {
      k0 = DIURNAL_KNOTS[i];
      k1 = DIURNAL_KNOTS[i + 1];
      break;
    }
  }
  const span = Math.max(1e-6, k1.hour - k0.hour);
  const w = smoothstep((h - k0.hour) / span);

  const paShare: Record<MobilityPurposeId, number> = {
    hbw: k0.hbw + (k1.hbw - k0.hbw) * w,
    hbe: k0.hbe + (k1.hbe - k0.hbe) * w,
    hbo: k0.hbo + (k1.hbo - k0.hbo) * w,
  };

  let phaseLabel: MobilityPhaseLabel;
  if (h >= 5.5 && h < 10.0) {
    phaseLabel = 'AM Rush';
  } else if (h >= 10.0 && h < 15.5) {
    phaseLabel = 'Midday';
  } else if (h >= 15.5 && h < 20.5) {
    phaseLabel = 'PM Rush';
  } else {
    phaseLabel = 'Night';
  }

  return { intensity, paShare, phaseLabel };
}

function haversineKm(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dphi = p2 - p1;
  const dl = (lon2 - lon1) * rad;
  const s1 = Math.sin(dphi * 0.5);
  const s2 = Math.sin(dl * 0.5);
  const a = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Build a doubly-constrained Furness-balanced gravity CDF over (i * nZones + j)
 * matching `trafficsim_map`'s power deterrence `max(d_km, 0.5)^(-beta)`.
 */
const ATTR_PURPOSE: Record<string, MobilityPurposeId> = { jobs: 'hbw', students: 'hbe', commerce: 'hbo' };

/**
 * Trips produced by each zone's residents for one purpose. Uses the age-based `prod` field when the
 * zones carry it (zones without it get population x the city rate), otherwise population.
 */
export function zoneProduction(zones: MobilityZoneMeta[], pid: MobilityPurposeId): Float64Array {
  const n = zones.length;
  const out = new Float64Array(n);
  let sumProd = 0;
  let sumPopWith = 0;
  for (const z of zones) {
    const v = z.prod?.[pid];
    if (typeof v === 'number') {
      sumProd += v;
      sumPopWith += Math.max(0, Number(z.pop) || 0);
    }
  }
  const cityRate = sumPopWith > 0 ? sumProd / sumPopWith : 0;
  for (let i = 0; i < n; i += 1) {
    const v = zones[i].prod?.[pid];
    out[i] =
      typeof v === 'number'
        ? Math.max(0, v)
        : cityRate > 0
          ? Math.max(0, Number(zones[i].pop) || 0) * cityRate
          : Math.max(0, Number(zones[i].pop) || 0);
  }
  return out;
}

export function buildGravityCdf(
  zones: MobilityZoneMeta[],
  attrField: string,
  beta: number,
  balanceIters = FURNESS_ITERS
): Float64Array {
  const n = zones.length;
  const totalCells = n * n;
  const cdf = new Float64Array(totalCells);
  if (n === 0) return cdf;
  if (n === 1) {
    cdf[0] = 1;
    return cdf;
  }

  const P = new Float64Array(n);
  const A = new Float64Array(n);
  let sumP = 0;
  let sumA = 0;

  const purposeForAttr = ATTR_PURPOSE[attrField];
  const prodByZone = purposeForAttr ? zoneProduction(zones, purposeForAttr) : null;

  for (let i = 0; i < n; i += 1) {
    const z = zones[i];
    const pVal = prodByZone ? prodByZone[i] : Math.max(0, Number(z.pop) || 0);
    let aRaw = 0;
    if (attrField === 'jobs') aRaw = Number(z.jobs) || 0;
    else if (attrField === 'students') aRaw = Number(z.students) || 0;
    else if (attrField === 'commerce') aRaw = Number(z.commerce) || 0;
    else aRaw = Number(z.pop) || 0;

    P[i] = pVal;
    A[i] = Math.max(0, aRaw);
    sumP += P[i];
    sumA += A[i];
  }

  if (sumP <= 0) {
    for (let i = 0; i < n; i += 1) P[i] = 1;
    sumP = n;
  }
  if (sumA <= 0) {
    for (let i = 0; i < n; i += 1) A[i] = P[i];
    sumA = sumP;
  }

  const targetP = new Float64Array(n);
  const targetA = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    targetP[i] = P[i] / sumP;
    targetA[i] = A[i] / sumA;
  }

  const T = new Float64Array(totalCells);
  let totalT = 0;
  for (let i = 0; i < n; i += 1) {
    const [lon1, lat1] = zones[i].centroid;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const [lon2, lat2] = zones[j].centroid;
      const d = Math.max(
        MIN_GRAVITY_DIST_KM,
        haversineKm(lon1, lat1, lon2, lat2)
      );
      const f = Math.pow(d, -beta);
      const val = targetP[i] * targetA[j] * f;
      T[i * n + j] = val;
      totalT += val;
    }
  }

  if (totalT <= 0) {
    const uniform = 1 / (n * (n - 1));
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i !== j) acc += uniform;
        cdf[i * n + j] = acc;
      }
    }
    cdf[totalCells - 1] = 1;
    return cdf;
  }

  const invInit = 1 / totalT;
  for (let k = 0; k < totalCells; k += 1) {
    T[k] *= invInit;
  }

  const rowSums = new Float64Array(n);
  const colSums = new Float64Array(n);

  for (let iter = 0; iter < balanceIters; iter += 1) {
    rowSums.fill(0);
    for (let i = 0; i < n; i += 1) {
      let s = 0;
      const rowOff = i * n;
      for (let j = 0; j < n; j += 1) {
        s += T[rowOff + j];
      }
      rowSums[i] = s;
    }
    for (let i = 0; i < n; i += 1) {
      const rs = rowSums[i];
      if (rs > 0) {
        const scale = targetP[i] / rs;
        const rowOff = i * n;
        for (let j = 0; j < n; j += 1) {
          T[rowOff + j] *= scale;
        }
      }
    }

    colSums.fill(0);
    for (let i = 0; i < n; i += 1) {
      const rowOff = i * n;
      for (let j = 0; j < n; j += 1) {
        colSums[j] += T[rowOff + j];
      }
    }
    for (let j = 0; j < n; j += 1) {
      const cs = colSums[j];
      if (cs > 0) {
        const scale = targetA[j] / cs;
        for (let i = 0; i < n; i += 1) {
          T[i * n + j] *= scale;
        }
      }
    }
  }

  let finalSum = 0;
  for (let k = 0; k < totalCells; k += 1) finalSum += T[k];
  const invFinal = finalSum > 0 ? 1 / finalSum : 0;

  let running = 0;
  for (let k = 0; k < totalCells; k += 1) {
    running += T[k] * invFinal;
    cdf[k] = running;
  }
  cdf[totalCells - 1] = 1;
  return cdf;
}

/**
 * Doubly-constrained zone gravity with road-distance skims and an intrazonal diagonal.
 * Returns column balancing factors so building-level choice can reuse the zone calibration.
 */
export function buildGravityModel(
  meta: MobilityZonesMetadata,
  betaScale: number,
  lambdaKm: number,
  attrBlend: number,
  balanceExp = DEFAULT_BALANCE,
  balanceIters = FURNESS_ITERS
): GravityModel | null {
  const zones = meta.zones;
  const skims = meta.skims;
  const n = zones.length;
  if (!skims || n < 2) return null;

  const scale = Math.max(0.1, Math.min(5.0, betaScale));
  const lam = Math.max(0.5, lambdaKm);
  const blend = Math.max(0, Math.min(1, attrBlend));

  // Circuity: median of road distance / straight-line distance between zone centroids
  const ratios: number[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const road = skims.od_km[i][j];
      const line = haversineKm(
        zones[i].centroid[0], zones[i].centroid[1], zones[j].centroid[0], zones[j].centroid[1]
      );
      if (road > 0 && line > 0.2) ratios.push(road / line);
    }
  }
  ratios.sort((a, b) => a - b);
  const circuity = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : 1.3;

  const roles: MobilityRole[] = ['home', 'work', 'school', 'other'];
  const cLon = roles.map(() => new Float64Array(n));
  const cLat = roles.map(() => new Float64Array(n));
  for (let r = 0; r < 4; r += 1) {
    for (let j = 0; j < n; j += 1) {
      const c = zones[j].bldg_centroid?.[roles[r]] ?? zones[j].centroid;
      cLon[r][j] = c[0];
      cLat[r][j] = c[1];
    }
  }

  const purposeIds: MobilityPurposeId[] = ['hbw', 'hbe', 'hbo'];
  const fallbackMeta: Record<MobilityPurposeId, { attr: string; beta: number }> = {
    hbw: { attr: 'jobs', beta: 1.3 },
    hbe: { attr: 'students', beta: 1.8 },
    hbo: { attr: 'commerce', beta: 1.5 },
  };
  const zoneWeight = {} as Record<MobilityPurposeId, Float64Array>;
  const betas = {} as Record<MobilityPurposeId, number>;
  const prodCdf = {} as Record<MobilityPurposeId, Float64Array>;

  for (const pid of purposeIds) {
    // Who produces this purpose: residents by age (school trips start where students live, ...).
    const P = zoneProduction(zones, pid);
    let sumP = 0;
    for (let i = 0; i < n; i += 1) sumP += P[i];
    if (sumP <= 0) {
      P.fill(1);
      sumP = n;
    }
    const cdfP = new Float64Array(n);
    let run = 0;
    for (let i = 0; i < n; i += 1) {
      run += P[i] / sumP;
      cdfP[i] = run;
    }
    cdfP[n - 1] = 1;
    prodCdf[pid] = cdfP;

    const pm = meta.purposes[pid] ?? { ...fallbackMeta[pid], share: 0, name: pid };
    const beta = (Number(pm.beta) || fallbackMeta[pid].beta) * scale;
    betas[pid] = beta;
    const field = pm.attr;
    const role: MobilityRole = pid === 'hbw' ? 'work' : pid === 'hbe' ? 'school' : 'other';

    const zoneA = new Float64Array(n);
    const bldgA = new Float64Array(n);
    let sumZ = 0;
    let sumB = 0;
    for (let j = 0; j < n; j += 1) {
      const z = zones[j];
      const raw =
        field === 'jobs' ? z.jobs : field === 'students' ? z.students : field === 'commerce' ? z.commerce : z.pop;
      zoneA[j] = Math.max(0, Number(raw) || 0);
      bldgA[j] = Math.max(0, Number(z.bldg_attr?.[role]) || 0);
      sumZ += zoneA[j];
      sumB += bldgA[j];
    }
    const A = new Float64Array(n);
    for (let j = 0; j < n; j += 1) {
      const zn = sumZ > 0 ? zoneA[j] / sumZ : 1 / n;
      const bn = sumB > 0 ? bldgA[j] / sumB : zn;
      A[j] = (1 - blend) * zn + blend * bn;
    }

    // Furness on T_ij = P_i A_j f_ij with intrazonal diagonal; track column factors b_j
    const T = new Float64Array(n * n);
    for (let i = 0; i < n; i += 1) {
      const dii = Math.max(INTRAZONAL_MIN_KM, 0.5 * (zones[i].nn_km ?? 1));
      for (let j = 0; j < n; j += 1) {
        const road = i === j ? dii : skims.od_km[i][j] > 0 ? skims.od_km[i][j] : 30;
        T[i * n + j] = (P[i] / sumP) * A[j] * impedance(road, beta, lam);
      }
    }
    const colB = new Float64Array(n).fill(1);
    for (let iter = 0; iter < balanceIters; iter += 1) {
      for (let i = 0; i < n; i += 1) {
        let rs = 0;
        for (let j = 0; j < n; j += 1) rs += T[i * n + j];
        if (rs > 0) {
          const f = P[i] / sumP / rs;
          for (let j = 0; j < n; j += 1) T[i * n + j] *= f;
        }
      }
      for (let j = 0; j < n; j += 1) {
        let cs = 0;
        for (let i = 0; i < n; i += 1) cs += T[i * n + j];
        if (cs > 0) {
          const f = A[j] / cs;
          colB[j] *= f;
          for (let i = 0; i < n; i += 1) T[i * n + j] *= f;
        }
      }
    }
    const w = new Float64Array(n);
    for (let j = 0; j < n; j += 1) w[j] = Math.pow(colB[j], balanceExp) * A[j];
    zoneWeight[pid] = w;
  }

  return {
    key: `${scale.toFixed(3)}|${lam.toFixed(2)}|${blend.toFixed(2)}|${balanceExp.toFixed(2)}`,
    prodCdf,
    zoneWeight,
    beta: betas,
    lambdaKm: lam,
    circuity,
    cLon,
    cLat,
  };
}

function binarySearchCdf(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] < u) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function createMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function binarySearchCumFrac(
  ptCumFrac: Float32Array,
  start: number,
  end: number,
  u: number
): number {
  const count = end - start;
  if (count <= 2) return start;
  if (count <= 8) {
    for (let i = start; i < end - 2; i += 1) {
      if (u <= ptCumFrac[i + 1]) return i;
    }
    return end - 2;
  }
  let lo = start;
  let hi = end - 2;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ptCumFrac[mid + 1] < u) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export interface TripTally {
  out: Uint32Array;
  in: Uint32Array;
  outScaled: Float32Array;
  inScaled: Float32Array;
  /** Simulated seconds covered by the tally. */
  simSec: number;
}

/** The running simulation, for read-only consumers outside the map (reports). */
let activeSimulation: MobilitySimulation | null = null;
export function setActiveSimulation(sim: MobilitySimulation | null): void {
  activeSimulation = sim;
}
export function getActiveSimulation(): MobilitySimulation | null {
  return activeSimulation;
}

export class MobilitySimulation {
  readonly dataset: MobilityDataset;
  readonly rng: () => number;

  // Preallocated render buffers (never reallocated during step/refreshVisuals)
  readonly positions = new Float32Array(MAX_AGENTS * 3);
  readonly colors = new Uint8Array(MAX_AGENTS * 4);
  readonly radii = new Float32Array(MAX_AGENTS);

  // Per-agent simulation state
  private readonly agentActive = new Uint8Array(MAX_AGENTS);
  private readonly agentOrigZone = new Uint16Array(MAX_AGENTS);
  private readonly agentDestZone = new Uint16Array(MAX_AGENTS);
  private readonly agentMode = new Uint8Array(MAX_AGENTS);
  private readonly agentPurpose = new Uint8Array(MAX_AGENTS);
  private readonly agentPassengers = new Uint8Array(MAX_AGENTS);
  private readonly agentEdgeCursor = new Uint16Array(MAX_AGENTS);
  private readonly agentEdgeElapsedSec = new Float32Array(MAX_AGENTS);
  private readonly agentTotalElapsedSec = new Float32Array(MAX_AGENTS);
  private readonly agentTotalDurSec = new Float32Array(MAX_AGENTS);
  private readonly agentTotalDistKm = new Float32Array(MAX_AGENTS);
  private readonly agentTripSerial = new Uint32Array(MAX_AGENTS);
  private readonly agentOrigBldg = new Int32Array(MAX_AGENTS).fill(-1);
  private readonly agentDestBldg = new Int32Array(MAX_AGENTS).fill(-1);
  /** Role (0 home, 1 work, 2 school, 3 other) the origin / destination building plays on this trip. */
  private readonly agentOrigRole = new Uint8Array(MAX_AGENTS);
  private readonly agentDestRole = new Uint8Array(MAX_AGENTS);
  private readonly spurScratch: Uint16Array;
  private buildingCdfs: Array<Float64Array | null> | null = null;
  private readonly agentDepartHours = new Float32Array(MAX_AGENTS);
  private tripSerialCounter = 0;
  private simHours = 7.75;
  private lastSampleScale = 1;
  // Per-building trip tally since the sim started (or resetTripTally): simulated spawns, and the
  // same weighted by how many real trips each sampled agent stands for at spawn time.
  private tallyOut = new Uint32Array(0);
  private tallyIn = new Uint32Array(0);
  private tallyOutScaled = new Float32Array(0);
  private tallyInScaled = new Float32Array(0);
  private tallySimSec = 0;
  private readonly agentRoutes: Array<Uint16Array | null> = new Array(
    MAX_AGENTS
  ).fill(null);

  // Preallocated per-edge congestion buffers (zero per-frame allocations)
  private readonly edgeCritPcu: Float32Array;
  private readonly edgePcuInstant: Float32Array;
  private readonly edgePcuSmooth: Float32Array;
  private readonly edgeVcRatio: Float32Array;
  private readonly edgeBprMult: Float32Array;
  private hasCongestionInit = false;
  private prevTotalTravellers = 0;

  // Mode physics tables
  private readonly modeOccMin = new Uint8Array(5);
  private readonly modeOccMax = new Uint8Array(5);
  private readonly modeAvgOcc = new Float32Array(5);
  private readonly modePcu = new Float32Array(5);
  private readonly modeCongests = new Uint8Array(5);
  private readonly modeLaneFilter = new Float32Array(5);

  // Reusable scratch buffers for zero-alloc route assembly & loop trimming
  private readonly visitedNodePos: Int32Array;
  private readonly stackNodes: Int32Array;
  private readonly stackEdges: Int32Array;
  private readonly trunkScratch: Uint16Array;

  // Cached gravity CDFs per betaScale key
  private cachedBetaKey = '';
  private gravityCdfs: Record<MobilityPurposeId, Float64Array> | null = null;
  private lastBetaScale: number | null = null;
  private gravityModel: GravityModel | null = null;
  private gravityLambdaKm = DEFAULT_LAMBDA_KM;
  private attrBlend = DEFAULT_ATTR_BLEND;
  private gravityBalance = DEFAULT_BALANCE;
  private lastGravityKey = '';
  private readonly zoneProbScratch: Float64Array;
  private readonly tripScratch = { prodZone: 0, attrZone: 0, homeB: -1, attrB: -1 };
  private readonly altBldgScratch = new Int32Array(K_ALTERNATIVES);
  private readonly utilScratch = new Float64Array(5);
  private readonly modeDurScratch = new Float64Array(5);
  private readonly modeFreeDurScratch = new Float64Array(5);
  private readonly feasibleScratch = new Uint8Array(5);
  private readonly unitWScratch = new Float64Array(5);
  private readonly profileDistScratch = new Float64Array(3);
  private readonly profileRoutesScratch: Array<Uint16Array | null> = [null, null, null];
  private spawnCounter = 0;
  private congAccumDtSec = 0;
  private congStepCounter = 0;
  /** Live motorized hub trees (profile 0), refreshed round-robin on congested times. */
  private dynPrev: Uint16Array[] | null = null;
  private routeNoise: Float32Array[] = [];
  private treeSolver: TreeSolver | null = null;
  private rerouteWeights: Float32Array | null = null;
  private nextRerouteZone = 0;
  private reroutedTrees = 0;
  private lastCongestion = { congestedEdgeCount: 0, peakVcRatio: 0 };
  private readonly altWScratch = new Float64Array(K_ALTERNATIVES);

  // Precomputed mode profile lookup & zone name lookup
  private readonly modeProfileIdx = new Uint8Array(5);
  private readonly zoneNameToIdx = new Map<string, number>();

  private activeDrawCount = 0;
  private lastDiurnal: MobilityDiurnalState = getDiurnalState(7.75);
  private lastStats: MobilitySimStats;

  /**
   * Ground height (terrain-exaggerated metres) at every road-geometry vertex, taken from the terrain the
   * map actually draws (see updateGroundHeights). NaN = not sampled yet; node elevations are the fallback.
   */
  private vertZ: Float32Array = new Float32Array(0);
  private vertZExag = Number.NaN;

  /**
   * Sample the drawn terrain at road vertices inside `bounds` ([west, south, east, north]). `sample`
   * returns terrain-exaggerated metres (MapLibre's own terrain lookup), so particles sit on the surface
   * the user sees. Returns the number of vertices updated.
   */
  updateGroundHeights(
    sample: (lon: number, lat: number) => number | null,
    exaggeration: number,
    bounds: [number, number, number, number]
  ): number {
    const ds = this.dataset;
    const nPts = ds.ptCumFrac.length;
    if (this.vertZ.length !== nPts || exaggeration !== this.vertZExag) {
      this.vertZ = new Float32Array(nPts).fill(Number.NaN);
      this.vertZExag = exaggeration;
    }
    const [w, s, e, n] = bounds;
    let updated = 0;
    for (let pt = 0; pt < nPts; pt += 1) {
      const lon = ds.geomCoords[pt * 2];
      const lat = ds.geomCoords[pt * 2 + 1];
      if (lon < w || lon > e || lat < s || lat > n) continue;
      const z = sample(lon, lat);
      if (z === null || !Number.isFinite(z)) continue;
      this.vertZ[pt] = z;
      updated += 1;
    }
    return updated;
  }

  /** Forget sampled ground heights (terrain switched off or its source changed). */
  clearGroundHeights(): void {
    this.vertZ.fill(Number.NaN);
  }

  /** Ground height at geometry vertex `pt`: sampled terrain when available, else the node-elevation estimate. */
  private groundAt(pt: number, fallbackElev: number, terrainEnabled: boolean, exaggeration: number): number {
    if (!terrainEnabled) return 0;
    if (pt >= 0 && pt < this.vertZ.length && exaggeration === this.vertZExag) {
      const v = this.vertZ[pt];
      // MapLibre answers 0 where no terrain tile is loaded; trust 0 only where the ground really is that low.
      if (Number.isFinite(v) && !(v === 0 && fallbackElev * exaggeration > 2)) return v;
    }
    return fallbackElev * exaggeration;
  }

  constructor(dataset: MobilityDataset, seed = 20261127) {
    this.dataset = dataset;
    this.rng = createMulberry32(seed);

    const nNodes = Math.max(1, dataset.nNodes);
    const nEdges = Math.max(1, dataset.nEdges);
    const scratchCap = Math.max(256, nNodes + 16);
    this.visitedNodePos = new Int32Array(nNodes).fill(-1);
    this.stackNodes = new Int32Array(scratchCap);
    this.stackEdges = new Int32Array(scratchCap);
    this.trunkScratch = new Uint16Array(scratchCap);
    this.spurScratch = new Uint16Array(scratchCap);
    this.zoneProbScratch = new Float64Array(dataset.nZones);

    this.edgeCritPcu = new Float32Array(nEdges);
    this.edgePcuInstant = new Float32Array(nEdges);
    this.edgePcuSmooth = new Float32Array(nEdges);
    this.edgeVcRatio = new Float32Array(nEdges);
    this.edgeBprMult = new Float32Array(nEdges).fill(1);

    const carOffset = 3 * dataset.nEdges;
    for (let e = 0; e < dataset.nEdges; e += 1) {
      const capHr =
        dataset.edgeCapacity && dataset.edgeCapacity.length > e && dataset.edgeCapacity[e] > 0
          ? dataset.edgeCapacity[e]
          : 1200;
      const carT0Sec = Math.max(1, dataset.edgeT0Sec[carOffset + e] ?? 6);
      this.edgeCritPcu[e] = Math.max(1.2, (capHr * carT0Sec) / 3600) * CONGESTION_TUNING.critScale;
    }

    for (let m = 0; m < 5; m += 1) {
      const id = MOBILITY_MODES_ORDER[m];
      const mapped = dataset.meta.mode_profile_map?.[id];
      this.modeProfileIdx[m] =
        typeof mapped === 'number' && mapped < dataset.nProfiles ? mapped : 0;

      const metaMode = dataset.meta.modes?.[m];
      const def = DEFAULT_MODE_PHYSICS[m];
      const oMin = Math.max(1, Math.round(metaMode?.occupancy_min ?? def.occMin));
      const oMax = Math.max(oMin, Math.round(metaMode?.occupancy_max ?? def.occMax));
      this.modeOccMin[m] = oMin;
      this.modeOccMax[m] = oMax;
      this.modeAvgOcc[m] = 0.5 * (oMin + oMax);
      this.modePcu[m] =
        typeof metaMode?.pcu === 'number' ? metaMode.pcu : def.pcu;
      this.modeCongests[m] =
        typeof metaMode?.congests === 'boolean'
          ? metaMode.congests
            ? 1
            : 0
          : def.congests
            ? 1
            : 0;
      this.modeLaneFilter[m] =
        typeof metaMode?.lane_filter === 'number'
          ? metaMode.lane_filter
          : def.laneFilter;
    }

    for (let i = 0; i < dataset.meta.zones.length; i += 1) {
      const z = dataset.meta.zones[i];
      this.zoneNameToIdx.set(z.name.trim().toLowerCase(), i);
    }

    this.lastStats = {
      activeAgents: 0,
      targetAgents: 15000,
      totalTravellers: 0,
      phaseLabel: 'AM Rush',
      modeCounts: { walk: 0, motorcycle: 0, tricycle: 0, car: 0, puv: 0 },
      modeTravellers: { walk: 0, motorcycle: 0, tricycle: 0, car: 0, puv: 0 },
      purposeCounts: { hbw: 0, hbe: 0, hbo: 0 },
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
      loaded: true,
    };
  }

  getActiveDrawCount(): number {
    return this.activeDrawCount;
  }

  getRenderSlice(): MobilityRenderSlice {
    return {
      count: this.activeDrawCount,
      positions: this.positions,
      colors: this.colors,
      radii: this.radii,
    };
  }

  getStats(): MobilitySimStats {
    return this.lastStats;
  }

  getGravityCdfs(
    betaScale: number
  ): Record<MobilityPurposeId, Float64Array> {
    const clampedScale = Math.max(0.1, Math.min(5.0, betaScale));
    const key = clampedScale.toFixed(3);
    if (this.gravityCdfs && this.cachedBetaKey === key) {
      return this.gravityCdfs;
    }

    const { zones, purposes } = this.dataset.meta;
    const hbwMeta = purposes.hbw ?? { attr: 'jobs', beta: 1.3, share: 0.48, name: 'Home-work' };
    const hbeMeta = purposes.hbe ?? { attr: 'students', beta: 1.8, share: 0.35, name: 'Home-school' };
    const hboMeta = purposes.hbo ?? { attr: 'commerce', beta: 1.5, share: 0.17, name: 'Home-other' };

    this.gravityCdfs = {
      hbw: buildGravityCdf(zones, hbwMeta.attr, hbwMeta.beta * clampedScale),
      hbe: buildGravityCdf(zones, hbeMeta.attr, hbeMeta.beta * clampedScale),
      hbo: buildGravityCdf(zones, hboMeta.attr, hboMeta.beta * clampedScale),
    };
    this.cachedBetaKey = key;
    return this.gravityCdfs;
  }

  /**
   * Assemble a loop-trimmed edge sequence from `origNode` to `destNode` via
   * `origZone.access_spurs[origNode][profileIdx]` and `fromHubPrevEdge`.
   */
  assembleLoopTrimmedRoute(
    origZoneIdx: number,
    origNode: number,
    destNode: number,
    profileIdx: number
  ): Uint16Array {
    const ds = this.dataset;
    const {
      nNodes,
      nZones,
      edgeSrc,
      edgeDst,
      fromHubPrevEdge,
      meta,
    } = ds;
    const origZone = meta.zones[origZoneIdx];
    const hubNode = origZone.hub_node;

    let spurEdges: ArrayLike<number> | undefined =
      origZone.access_spurs?.[String(origNode)]?.[profileIdx];
    const toHub = ds.buildings?.toHubNextEdge;
    if (toHub && origNode !== hubNode) {
      // Building-level access: trace any node to the hub via the next-edge tree.
      const spurBase = (profileIdx * nZones + origZoneIdx) * nNodes;
      let n = 0;
      let cur = origNode;
      while (cur !== hubNode && n < this.spurScratch.length) {
        const e = toHub[spurBase + cur];
        if (e === INVALID_EDGE || e >= ds.nEdges) break;
        this.spurScratch[n] = e;
        n += 1;
        cur = edgeDst[e];
      }
      spurEdges = cur === hubNode ? this.spurScratch.subarray(0, n) : undefined;
    }
    const hasSpur = !!spurEdges && spurEdges.length > 0;
    const startNode =
      origNode === hubNode || hasSpur ? origNode : hubNode;

    // Trace shortest path backwards from destNode to hubNode
    let trunkLen = 0;
    let curr = destNode;
    const baseOff = (profileIdx * nZones + origZoneIdx) * nNodes;
    const trunkPrev =
      profileIdx === 0 && this.dynPrev
        ? this.dynPrev[Math.floor(this.rng() * ROUTE_VARIANTS)]
        : fromHubPrevEdge;
    const trunkBase = trunkPrev === fromHubPrevEdge ? baseOff : origZoneIdx * nNodes;
    let reachedHub = curr === hubNode;

    while (!reachedHub && trunkLen < this.trunkScratch.length) {
      const prevEdge = trunkPrev[trunkBase + curr];
      if (prevEdge === INVALID_EDGE || prevEdge >= ds.nEdges) {
        break;
      }
      this.trunkScratch[trunkLen] = prevEdge;
      trunkLen += 1;
      curr = edgeSrc[prevEdge];
      if (curr === hubNode) {
        reachedHub = true;
      }
    }

    if (!reachedHub) {
      trunkLen = 0;
    }

    // Walk combined sequence [spurEdges..., reversed(trunkScratch)] with loop trimming
    const visited = this.visitedNodePos;
    const sNodes = this.stackNodes;
    const sEdges = this.stackEdges;
    let len = 0;
    sNodes[0] = startNode;
    visited[startNode] = 0;

    const pushEdge = (e: number) => {
      if (e >= ds.nEdges) return;
      const u = edgeSrc[e];
      const v = edgeDst[e];
      if (u !== sNodes[len]) return;

      const prevPos = visited[v];
      if (prevPos >= 0) {
        for (let p = len; p > prevPos; p -= 1) {
          visited[sNodes[p]] = -1;
        }
        len = prevPos;
      } else if (len + 1 < sNodes.length) {
        sEdges[len] = e;
        len += 1;
        sNodes[len] = v;
        visited[v] = len;
      }
    };

    if (hasSpur && spurEdges && startNode === origNode) {
      for (let i = 0; i < spurEdges.length; i += 1) {
        pushEdge(spurEdges[i]);
      }
    }

    for (let i = trunkLen - 1; i >= 0; i -= 1) {
      pushEdge(this.trunkScratch[i]);
    }

    for (let p = 0; p <= len; p += 1) {
      visited[sNodes[p]] = -1;
    }

    const out = new Uint16Array(len);
    for (let i = 0; i < len; i += 1) {
      out[i] = sEdges[i];
    }
    return out;
  }

  /**
   * Real travellers on the road at the daily peak: population x trips/person/day x peak-hour
   * share x mean trip duration (h). Falls back to the legacy constant without demand data.
   */
  peakConcurrentPeople(): number {
    const demand = this.dataset.meta.demand;
    if (!demand || !(demand.population > 0)) return CONCURRENT_CITY_PEOPLE_PEAK;
    const tripMin = Math.max(5, Math.min(60, this.lastStats.avgTripMin > 0 ? this.lastStats.avgTripMin : 15));
    return demand.population * demand.trips_per_person * demand.peak_share * (tripMin / 60);
  }

  /** Detect changes to gravity-model parameters (also forces a respawn like beta changes). */
  private gravityParamsChanged(params: MobilitySimParams): boolean {
    this.gravityLambdaKm = params.gravityLambdaKm ?? DEFAULT_LAMBDA_KM;
    this.attrBlend = params.attrBlend ?? DEFAULT_ATTR_BLEND;
    this.gravityBalance = params.gravityBalance ?? DEFAULT_BALANCE;
    const key = `${params.betaScale.toFixed(3)}|${this.gravityLambdaKm.toFixed(2)}|${this.attrBlend.toFixed(2)}|${this.gravityBalance.toFixed(2)}`;
    const changed = this.lastGravityKey !== '' && key !== this.lastGravityKey;
    this.lastGravityKey = key;
    return changed;
  }

  getGravityModel(betaScale: number): GravityModel | null {
    if (!this.dataset.buildings || !this.dataset.meta.skims) return null;
    const key = `${Math.max(0.1, Math.min(5, betaScale)).toFixed(3)}|${Math.max(0.5, this.gravityLambdaKm).toFixed(2)}|${Math.max(0, Math.min(1, this.attrBlend)).toFixed(2)}|${this.gravityBalance.toFixed(2)}`;
    if (this.gravityModel && this.gravityModel.key === key) return this.gravityModel;
    this.gravityModel = buildGravityModel(
      this.dataset.meta,
      betaScale,
      this.gravityLambdaKm,
      this.attrBlend,
      this.gravityBalance
    );
    return this.gravityModel;
  }

  /**
   * Building-level trip selection: pick a production-side home building, then the attraction
   * zone from that building's own location (b_j * A_j * f(d)), then the destination building
   * from K candidates weighted by distance decay. Returns false when data is missing.
   */
  private selectBuildingTrip(
    gm: GravityModel,
    purposeId: MobilityPurposeId,
    out: { prodZone: number; attrZone: number; homeB: number; attrB: number }
  ): boolean {
    const ds = this.dataset;
    const b = ds.buildings;
    if (!b) return false;
    const n = ds.nZones;
    const zones = ds.meta.zones;
    const attrRole: MobilityRole =
      purposeId === 'hbw' ? 'work' : purposeId === 'hbe' ? 'school' : 'other';
    const attrRoleIdx = ROLE_INDEX[attrRole];

    const prodZone = binarySearchCdf(gm.prodCdf[purposeId], this.rng());
    const homeB = this.sampleBuilding(prodZone, 'home');
    if (homeB < 0) return false;
    const oLon = b.lon[homeB];
    const oLat = b.lat[homeB];
    const kLon = DEG_KM_LON_AT_EQ * Math.cos((oLat * Math.PI) / 180);
    const beta = gm.beta[purposeId];
    const lam = gm.lambdaKm;
    const wZone = gm.zoneWeight[purposeId];
    const cLon = gm.cLon[attrRoleIdx];
    const cLat = gm.cLat[attrRoleIdx];
    const prob = this.zoneProbScratch;

    let total = 0;
    for (let j = 0; j < n; j += 1) {
      let w = wZone[j];
      if (w > 0) {
        const dx = (cLon[j] - oLon) * kLon;
        const dy = (cLat[j] - oLat) * DEG_KM_LAT;
        let d = gm.circuity * Math.hypot(dx, dy);
        if (j === prodZone) {
          d = Math.max(d, INTRAZONAL_MIN_KM, 0.5 * (zones[j].nn_km ?? 1));
        } else if (d < INTRAZONAL_MIN_KM) {
          d = INTRAZONAL_MIN_KM;
        }
        w *= impedance(d, beta, lam);
      }
      prob[j] = w;
      total += w;
    }
    if (total <= 0) return false;
    let r = this.rng() * total;
    let attrZone = n - 1;
    for (let j = 0; j < n; j += 1) {
      r -= prob[j];
      if (r <= 0) {
        attrZone = j;
        break;
      }
    }

    // Destination building: K candidates by attraction, then choose by distance decay
    let k = 0;
    let wSum = 0;
    for (let c = 0; c < K_ALTERNATIVES; c += 1) {
      const cand = this.sampleBuilding(attrZone, attrRole);
      if (cand < 0) break;
      const dx = (b.lon[cand] - oLon) * kLon;
      const dy = (b.lat[cand] - oLat) * DEG_KM_LAT;
      let d = gm.circuity * Math.hypot(dx, dy);
      d = Math.max(d, INTRAZONAL_MIN_KM * 0.5);
      const w = impedance(d, beta, lam);
      this.altBldgScratch[k] = cand;
      this.altWScratch[k] = w;
      wSum += w;
      k += 1;
    }
    if (k === 0 || wSum <= 0) return false;
    let rr = this.rng() * wSum;
    let attrB = this.altBldgScratch[k - 1];
    for (let c = 0; c < k; c += 1) {
      rr -= this.altWScratch[c];
      if (rr <= 0) {
        attrB = this.altBldgScratch[c];
        break;
      }
    }
    if (attrB === homeB) return false;
    out.prodZone = prodZone;
    out.attrZone = attrZone;
    out.homeB = homeB;
    out.attrB = attrB;
    return true;
  }

  /** Cumulative role-weight table for one zone (index = zone*4 + role). */
  private getBuildingCdf(zoneIdx: number, roleIdx: number): Float64Array | null {
    const b = this.dataset.buildings;
    if (!b) return null;
    if (!this.buildingCdfs) {
      this.buildingCdfs = new Array(this.dataset.nZones * 4).fill(null);
    }
    const key = zoneIdx * 4 + roleIdx;
    const cached = this.buildingCdfs[key];
    if (cached) return cached;
    const start = b.zoneOffs[zoneIdx];
    const end = b.zoneOffs[zoneIdx + 1];
    const w = b.weights[roleIdx];
    const cdf = new Float64Array(end - start);
    let acc = 0;
    for (let i = start; i < end; i += 1) {
      acc += w[i] / BUILDING_WEIGHT_SCALE;
      cdf[i - start] = acc;
    }
    this.buildingCdfs[key] = cdf;
    return cdf;
  }

  /** Pick a specific building in a zone weighted by its suitability for the given role. */
  private sampleBuilding(zoneIdx: number, role: MobilityRole): number {
    const b = this.dataset.buildings;
    if (!b) return -1;
    const roleIdx = ROLE_INDEX[role];
    let cdf = this.getBuildingCdf(zoneIdx, roleIdx);
    if (!cdf || cdf.length === 0 || cdf[cdf.length - 1] <= 0) {
      cdf = this.getBuildingCdf(zoneIdx, 3);
    }
    if (!cdf || cdf.length === 0 || cdf[cdf.length - 1] <= 0) return -1;
    const idx = binarySearchCdf(cdf, this.rng() * cdf[cdf.length - 1]);
    return b.zoneOffs[zoneIdx] + Math.min(cdf.length - 1, Math.max(0, idx));
  }

  private describeBuilding(index: number, role: MobilityRole): MobilityBuildingRef | null {
    const b = this.dataset.buildings;
    if (!b || index < 0 || index >= b.count) return null;
    const named = b.named[String(index)];
    const ds = this.dataset;
    const nid = b.node[index];
    const dxM = (b.lon[index] - ds.nodeLon[nid]) * 111320 * Math.cos((b.lat[index] * Math.PI) / 180);
    const dyM = (b.lat[index] - ds.nodeLat[nid]) * 110574;
    return {
      accessM: Math.hypot(dxM, dyM),
      index,
      role,
      lon: b.lon[index],
      lat: b.lat[index],
      bclass: b.classes[b.cls[index]] ?? 'unknown',
      areaM2: b.areaM2[index],
      name: named ? named[1] : null,
      id: buildingGersId(b, index) ?? (named && named[0] ? named[0] : null),
    };
  }

  private sampleAccessNode(zone: MobilityZoneMeta, role: MobilityRole): number {
    const list =
      zone.access_nodes?.[role]?.length
        ? zone.access_nodes[role]
        : zone.access_nodes?.other;
    if (!list || list.length === 0) {
      return zone.hub_node;
    }
    let totalW = 0;
    for (let i = 0; i < list.length; i += 1) {
      totalW += Math.max(0, list[i][1]);
    }
    if (totalW <= 0) {
      return list[Math.floor(this.rng() * list.length)][0];
    }
    let target = this.rng() * totalW;
    for (let i = 0; i < list.length; i += 1) {
      target -= Math.max(0, list[i][1]);
      if (target <= 0) return list[i][0];
    }
    return list[list.length - 1][0];
  }

  private pickPurposeIndex(): number {
    const purposes = this.dataset.meta.purposes;
    const w0 = purposes.hbw?.share ?? 0.48;
    const w1 = purposes.hbe?.share ?? 0.35;
    const w2 = purposes.hbo?.share ?? 0.17;
    const total = w0 + w1 + w2;
    const r = this.rng() * (total > 0 ? total : 1);
    if (r < w0) return 0;
    if (r < w0 + w1) return 1;
    return 2;
  }

  private getEffectiveEdgeMult(
    modeIdx: number,
    edgeId: number,
    congestionEnabled: boolean
  ): number {
    if (!congestionEnabled || !this.modeCongests[modeIdx]) {
      return 1.0;
    }
    const baseMult = this.edgeBprMult[edgeId];
    if (baseMult <= 1.0001) return 1.0;
    return 1.0 + this.modeLaneFilter[modeIdx] * (baseMult - 1.0);
  }

  private updateCongestionField(
    dtSimSec: number,
    diurnalIntensity: number,
    params: MobilitySimParams
  ): { congestedEdgeCount: number; peakVcRatio: number } {
    const congestionEnabled = params.congestionEnabled ?? true;
    const nEdges = this.dataset.nEdges;

    {
      const ls = Math.max(0.25, Math.min(3.0, params.congestionLoadScale ?? 1.0));
      const people = this.peakConcurrentPeople() * diurnalIntensity * ls;
      const cur =
        this.prevTotalTravellers > 0
          ? this.prevTotalTravellers
          : Math.max(1, this.activeDrawCount * 1.8);
      this.lastSampleScale = Math.max(0.1, Math.min(25.0, people / Math.max(1, cur)));
    }

    if (!congestionEnabled || nEdges === 0) {
      this.edgePcuSmooth.fill(0);
      this.edgeVcRatio.fill(0);
      this.edgeBprMult.fill(1);
      this.hasCongestionInit = false;
      return { congestedEdgeCount: 0, peakVcRatio: 0 };
    }

    const loadScale = Math.max(0.25, Math.min(3.0, params.congestionLoadScale ?? 1.0));
    this.edgePcuInstant.fill(0);

    const realCityPeople = this.peakConcurrentPeople() * diurnalIntensity * loadScale;
    let currentTravellers = this.prevTotalTravellers;
    if (currentTravellers <= 0) {
      currentTravellers = Math.max(1, this.activeDrawCount * 1.8);
    }
    const pcuScale = Math.max(
      0.1,
      Math.min(25.0, realCityPeople / Math.max(1, currentTravellers))
    );

    for (let i = 0; i < this.activeDrawCount; i += 1) {
      if (!this.agentActive[i]) continue;
      const m = this.agentMode[i];
      if (!this.modeCongests[m]) continue;
      const route = this.agentRoutes[i];
      if (!route || route.length === 0) continue;
      const cursor = Math.min(route.length - 1, this.agentEdgeCursor[i]);
      const e = route[cursor];
      if (e < nEdges) {
        this.edgePcuInstant[e] += this.modePcu[m] * pcuScale;
      }
    }

    const alpha = !this.hasCongestionInit
      ? 1.0
      : dtSimSec > 0
        ? 1.0 - Math.exp(-dtSimSec / CONGESTION_SMOOTH_TAU_SEC)
        : 0.25;
    this.hasCongestionInit = true;

    let congestedEdgeCount = 0;
    let peakVcRatio = 0;

    for (let e = 0; e < nEdges; e += 1) {
      const smoothed =
        this.edgePcuSmooth[e] +
        alpha * (this.edgePcuInstant[e] - this.edgePcuSmooth[e]);
      this.edgePcuSmooth[e] = smoothed;
      const vc = smoothed / Math.max(0.5, this.edgeCritPcu[e]);
      this.edgeVcRatio[e] = vc;
      if (vc > peakVcRatio) peakVcRatio = vc;
      if (vc >= 0.85) congestedEdgeCount += 1;
      const vc4 = vc * vc * vc * vc;
      this.edgeBprMult[e] = Math.min(MAX_BPR_MULT, 1.0 + BPR_ALPHA * vc4);
    }

    return { congestedEdgeCount, peakVcRatio };
  }

  /**
   * Re-solve one destination zone's motorized hub tree on live congested car times, so new trips
   * route around jams. Round-robin: a full cycle takes nZones x REROUTE_EVERY_N_STEPS steps.
   */
  private refreshRoutingTree(): void {
    const ds = this.dataset;
    const { nNodes, nEdges, nZones } = ds;
    if (nZones === 0 || nEdges === 0) return;
    if (!this.dynPrev) {
      this.dynPrev = [];
      for (let v = 0; v < ROUTE_VARIANTS; v += 1) {
        this.dynPrev.push(ds.fromHubPrevEdge.slice(0, nZones * nNodes));
        const noiseRng = createMulberry32(0x9e3779b1 ^ (v * 7919 + 1));
        const noise = new Float32Array(nEdges);
        for (let e = 0; e < nEdges; e += 1) {
          const u1 = Math.max(1e-9, noiseRng());
          const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * noiseRng());
          noise[e] = Math.exp(ROUTE_NOISE_SIGMA * g);
        }
        this.routeNoise.push(noise);
      }
      this.rerouteWeights = new Float32Array(nEdges);
      this.treeSolver = new TreeSolver(
        nNodes,
        nEdges,
        buildOutAdjacency(nNodes, ds.edgeSrc, nEdges),
        ds.edgeDst
      );
    }
    const w = this.rerouteWeights!;
    const carBase = 3 * nEdges;
    const mult = this.edgeBprMult;
    // Round-robin over (variant, zone) pairs; each variant has its own fixed cost perturbation.
    const slot = this.nextRerouteZone;
    const z = slot % nZones;
    const v = Math.floor(slot / nZones) % ROUTE_VARIANTS;
    const noise = this.routeNoise[v];
    for (let e = 0; e < nEdges; e += 1) {
      const t = ds.edgeT0Sec[carBase + e];
      w[e] = t >= BANNED_EDGE_SEC ? Infinity : t * mult[e] * noise[e];
    }
    this.treeSolver!.solve(
      ds.meta.zones[z].hub_node,
      w,
      Infinity,
      this.dynPrev[v],
      z * nNodes
    );
    this.nextRerouteZone = (slot + 1) % (nZones * ROUTE_VARIANTS);
    this.reroutedTrees += 1;
  }

  /** Number of tree refreshes performed (diagnostics/tests). */
  /**
   * Per-edge live load for corridor reports: sampled agents currently on each edge, smoothed PCU
   * (scaled to the represented population), volume/capacity and car speed as a share of free flow.
   * Instantaneous agent counts are noisy; the smoothed fields average over about a sim minute.
   */
  getEdgeLoad(): { agents: Uint16Array; pcu: Float32Array; vc: Float32Array; speedRatio: Float32Array } {
    const n = this.dataset.nEdges;
    const agents = new Uint16Array(n);
    for (let i = 0; i < this.activeDrawCount; i += 1) {
      if (!this.agentActive[i]) continue;
      const route = this.agentRoutes[i];
      if (!route || route.length === 0) continue;
      const e = route[Math.min(route.length - 1, this.agentEdgeCursor[i])];
      if (e < n && agents[e] < 0xffff) agents[e] += 1;
    }
    const speedRatio = new Float32Array(n);
    for (let e = 0; e < n; e += 1) speedRatio[e] = 1 / Math.max(1, this.edgeBprMult[e]);
    return { agents, pcu: this.edgePcuSmooth.slice(), vc: this.edgeVcRatio.slice(), speedRatio };
  }

  private tallyTrip(orig: number, dest: number): void {
    const n = this.dataset.buildings?.count ?? 0;
    if (n === 0) return;
    if (this.tallyOut.length !== n) {
      this.tallyOut = new Uint32Array(n);
      this.tallyIn = new Uint32Array(n);
      this.tallyOutScaled = new Float32Array(n);
      this.tallyInScaled = new Float32Array(n);
    }
    const w = this.lastSampleScale;
    if (orig >= 0 && orig < n) {
      this.tallyOut[orig] += 1;
      this.tallyOutScaled[orig] += w;
    }
    if (dest >= 0 && dest < n) {
      this.tallyIn[dest] += 1;
      this.tallyInScaled[dest] += w;
    }
  }

  /** Trips produced (out) and attracted (in) per building since start or the last reset. */
  getTripTally(): TripTally {
    const n = this.dataset.buildings?.count ?? 0;
    if (this.tallyOut.length !== n) {
      this.tallyOut = new Uint32Array(n);
      this.tallyIn = new Uint32Array(n);
      this.tallyOutScaled = new Float32Array(n);
      this.tallyInScaled = new Float32Array(n);
    }
    return {
      out: this.tallyOut,
      in: this.tallyIn,
      outScaled: this.tallyOutScaled,
      inScaled: this.tallyInScaled,
      simSec: this.tallySimSec,
    };
  }

  resetTripTally(): void {
    this.tallyOut.fill(0);
    this.tallyIn.fill(0);
    this.tallyOutScaled.fill(0);
    this.tallyInScaled.fill(0);
    this.tallySimSec = 0;
  }

  getEdgeLengthsKm(): Float32Array {
    return this.dataset.edgeLenKm;
  }

  getRerouteCount(): number {
    return this.reroutedTrees;
  }

  private spawnAgent(
    slot: number,
    diurnal: MobilityDiurnalState,
    betaScale: number,
    randomizeProgress: boolean,
    congestionEnabled = true
  ): void {
    const ds = this.dataset;
    const nZones = ds.nZones;
    if (nZones === 0 || ds.nEdges === 0) {
      this.agentActive[slot] = 0;
      return;
    }

    const cdfs = this.getGravityCdfs(betaScale);

    // Retry a few times if an OD node pair happens to produce a 0-edge route
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const purposeIdx = this.pickPurposeIndex();
      const purposeId = PURPOSE_IDS[purposeIdx];
      const cdf = cdfs[purposeId];

      let prodZoneIdx: number;
      let attrZoneIdx: number;
      let preHome = -1;
      let preAttr = -1;
      const gm = this.getGravityModel(betaScale);
      if (gm && this.selectBuildingTrip(gm, purposeId, this.tripScratch)) {
        prodZoneIdx = this.tripScratch.prodZone;
        attrZoneIdx = this.tripScratch.attrZone;
        preHome = this.tripScratch.homeB;
        preAttr = this.tripScratch.attrB;
      } else {
        const pairIdx = binarySearchCdf(cdf, this.rng());
        prodZoneIdx = Math.floor(pairIdx / nZones);
        attrZoneIdx = pairIdx % nZones;
      }

      const isPA = this.rng() < diurnal.paShare[purposeId];
      const origZoneIdx = isPA ? prodZoneIdx : attrZoneIdx;
      const destZoneIdx = isPA ? attrZoneIdx : prodZoneIdx;

      const attrRole: MobilityRole =
        purposeId === 'hbw'
          ? 'work'
          : purposeId === 'hbe'
            ? 'school'
            : 'other';
      const origRole: MobilityRole = isPA ? 'home' : attrRole;
      const destRole: MobilityRole = isPA ? attrRole : 'home';

      const origZone = ds.meta.zones[origZoneIdx];
      const destZone = ds.meta.zones[destZoneIdx];

      let origBldg: number;
      let destBldg: number;
      if (preHome >= 0 && preAttr >= 0) {
        origBldg = isPA ? preHome : preAttr;
        destBldg = isPA ? preAttr : preHome;
      } else {
        origBldg = this.sampleBuilding(origZoneIdx, origRole);
        destBldg = this.sampleBuilding(destZoneIdx, destRole);
        if (destBldg === origBldg && destBldg >= 0) {
          destBldg = this.sampleBuilding(destZoneIdx, destRole);
        }
      }
      const bt = ds.buildings;
      const origNode =
        bt && origBldg >= 0 ? bt.node[origBldg] : this.sampleAccessNode(origZone, origRole);
      let destNode =
        bt && destBldg >= 0 ? bt.node[destBldg] : this.sampleAccessNode(destZone, destRole);
      if (destNode === origNode && destZone.hub_node !== origNode && destBldg < 0) {
        destNode = destZone.hub_node;
      }

      // Build candidate routes per routing profile (at most 3)
      const profileRoutes = this.profileRoutesScratch;
      const profileDistKm = this.profileDistScratch;
      profileRoutes[0] = profileRoutes[1] = profileRoutes[2] = null;
      profileDistKm.fill(0);

      // Skip profiles that cannot win the mode choice at this straight-line distance
      const straightKm =
        Math.hypot(
          (ds.nodeLon[destNode] - ds.nodeLon[origNode]) *
            DEG_KM_LON_AT_EQ *
            Math.cos((ds.nodeLat[origNode] * Math.PI) / 180),
          (ds.nodeLat[destNode] - ds.nodeLat[origNode]) * DEG_KM_LAT
        );

      for (let p = 0; p < ds.nProfiles; p += 1) {
        if (p === 2 && straightKm > WALK_MAX_STRAIGHT_KM) continue;
        if (p === 1 && straightKm > TRICYCLE_MAX_STRAIGHT_KM) continue;
        const route = this.assembleLoopTrimmedRoute(
          origZoneIdx,
          origNode,
          destNode,
          p
        );
        profileRoutes[p] = route;
        let dist = 0;
        for (let i = 0; i < route.length; i += 1) {
          dist += ds.edgeLenKm[route[i]];
        }
        profileDistKm[p] = dist;
      }

      // Multinomial logit across the 5 modes (using live congested travel times when enabled)
      const utilities = this.utilScratch;
      const modeDurSec = this.modeDurScratch;
      const modeFreeDurSec = this.modeFreeDurScratch;
      const feasible = this.feasibleScratch;
      utilities.fill(0);
      modeDurSec.fill(0);
      modeFreeDurSec.fill(0);
      feasible.fill(0);
      let maxU = -Infinity;
      let feasibleCount = 0;

      for (let m = 0; m < 5; m += 1) {
        const p = this.modeProfileIdx[m];
        const route = profileRoutes[p];
        if (!route || route.length === 0) continue;

        let freeDurSec = 0;
        let congDurSec = 0;
        const t0Base = m * ds.nEdges;
        for (let i = 0; i < route.length; i += 1) {
          const eid = route[i];
          const tEdge = ds.edgeT0Sec[t0Base + eid];
          freeDurSec += tEdge;
          congDurSec += tEdge * this.getEffectiveEdgeMult(m, eid, congestionEnabled);
        }
        if (!Number.isFinite(freeDurSec) || freeDurSec <= 0 || freeDurSec >= 1e7) {
          continue;
        }

        const modeMeta = ds.meta.modes[m];
        const distKm = profileDistKm[p];
        const durMin = congDurSec / 60;
        const util =
          (modeMeta?.asc ?? 0) +
          (modeMeta?.beta_cost ?? -0.04) * (modeMeta?.cost_per_km ?? 0) * distKm +
          (modeMeta?.beta_duration ?? -0.05) * durMin;

        utilities[m] = util;
        modeDurSec[m] = congDurSec;
        modeFreeDurSec[m] = freeDurSec;
        feasible[m] = 1;
        feasibleCount += 1;
        if (util > maxU) maxU = util;
      }

      if (feasibleCount === 0) continue;

      // Convert person-trip logit probability to physical unit probability via P_m / avgOccupancy_m
      let unitSum = 0;
      const unitWeights = this.unitWScratch;
      unitWeights.fill(0);
      for (let m = 0; m < 5; m += 1) {
        if (!feasible[m]) continue;
        const personW = Math.exp(utilities[m] - maxU);
        const unitW = personW / Math.max(1, this.modeAvgOcc[m]);
        unitWeights[m] = unitW;
        unitSum += unitW;
      }

      let chosenMode = 0;
      let r = this.rng() * (unitSum > 0 ? unitSum : 1);
      for (let m = 0; m < 5; m += 1) {
        if (!feasible[m]) continue;
        chosenMode = m;
        r -= unitWeights[m];
        if (r <= 0) break;
      }

      const chosenProfile = this.modeProfileIdx[chosenMode];
      const chosenRoute = profileRoutes[chosenProfile]!;
      const totalFreeDurSec = modeFreeDurSec[chosenMode];
      const totalDistKm = profileDistKm[chosenProfile];
      const oMin = this.modeOccMin[chosenMode];
      const oMax = this.modeOccMax[chosenMode];
      const passengers =
        oMin === oMax ? oMin : oMin + Math.floor(this.rng() * (oMax - oMin + 1));

      this.agentActive[slot] = 1;
      this.agentOrigZone[slot] = origZoneIdx;
      this.agentDestZone[slot] = destZoneIdx;
      this.agentMode[slot] = chosenMode;
      this.agentPurpose[slot] = purposeIdx;
      this.agentPassengers[slot] = passengers;
      this.agentTotalDurSec[slot] = totalFreeDurSec;
      this.agentTotalDistKm[slot] = totalDistKm;
      this.agentRoutes[slot] = chosenRoute;
      this.agentOrigRole[slot] = ROLE_INDEX[origRole];
      this.agentDestRole[slot] = ROLE_INDEX[destRole];
      this.agentOrigBldg[slot] = origBldg;
      this.agentDestBldg[slot] = destBldg;
      if (!randomizeProgress) this.tallyTrip(origBldg, destBldg); // initial seeding is not a real arrival
      this.tripSerialCounter += 1;
      this.spawnCounter += 1;
      this.agentTripSerial[slot] = this.tripSerialCounter;

      if (randomizeProgress && totalFreeDurSec > 0) {
        const targetElapsed = this.rng() * totalFreeDurSec;
        this.seekAgentToTime(slot, chosenMode, chosenRoute, targetElapsed);
      } else {
        this.agentEdgeCursor[slot] = 0;
        this.agentEdgeElapsedSec[slot] = 0;
        this.agentTotalElapsedSec[slot] = 0;
      }
      this.agentDepartHours[slot] =
        (((this.simHours - this.agentTotalElapsedSec[slot] / 3600) % 24) + 24) % 24;
      return;
    }

    this.agentActive[slot] = 0;
  }

  private seekAgentToTime(
    slot: number,
    modeIdx: number,
    route: Uint16Array,
    targetSec: number
  ): void {
    const t0Base = modeIdx * this.dataset.nEdges;
    let rem = Math.max(0, targetSec);
    let cursor = 0;
    while (cursor < route.length - 1) {
      const dur = Math.max(0.05, this.dataset.edgeT0Sec[t0Base + route[cursor]]);
      if (rem < dur) break;
      rem -= dur;
      cursor += 1;
    }
    const lastDur = Math.max(
      0.05,
      this.dataset.edgeT0Sec[t0Base + route[cursor]]
    );
    this.agentEdgeCursor[slot] = cursor;
    this.agentEdgeElapsedSec[slot] = Math.min(lastDur, rem);
    this.agentTotalElapsedSec[slot] = Math.min(
      this.agentTotalDurSec[slot],
      targetSec
    );
  }

  private writeAgentPositionAndVisuals(
    slot: number,
    params: MobilitySimParams,
    selectedZoneIdx: number
  ): void {
    const route = this.agentRoutes[slot];
    if (!route || route.length === 0 || !this.agentActive[slot]) {
      this.colors[slot * 4 + 3] = 0;
      this.radii[slot] = 0;
      return;
    }

    const ds = this.dataset;
    const modeIdx = this.agentMode[slot];
    const cursor = Math.min(route.length - 1, this.agentEdgeCursor[slot]);
    const edgeId = route[cursor];
    const freeDur = Math.max(0.05, ds.edgeT0Sec[modeIdx * ds.nEdges + edgeId]);
    const u = Math.max(0, Math.min(1, this.agentEdgeElapsedSec[slot] / freeDur));

    const startPt = ds.geomOffs[edgeId];
    const endPt = ds.geomOffs[edgeId + 1];
    const srcNode = ds.edgeSrc[edgeId];
    const dstNode = ds.edgeDst[edgeId];
    let lon = ds.nodeLon[srcNode];
    let lat = ds.nodeLat[srcNode];
    let segDx = ds.nodeLon[dstNode] - lon;
    let segDy = ds.nodeLat[dstNode] - lat;
    const elevSrc = ds.nodeElev[srcNode];
    const elevDst = ds.nodeElev[dstNode];
    const tEnabled = params.terrainEnabled;
    const tExag = params.terrainExaggeration;
    let ground = this.groundAt(-1, elevSrc + (elevDst - elevSrc) * u, tEnabled, tExag);

    if (endPt - startPt >= 2) {
      const segIdx = binarySearchCumFrac(ds.ptCumFrac, startPt, endPt, u);
      const f0 = ds.ptCumFrac[segIdx];
      const f1 = ds.ptCumFrac[segIdx + 1];
      const span = f1 - f0;
      const localT = span > 1e-9 ? Math.max(0, Math.min(1, (u - f0) / span)) : 0;

      const x0 = ds.geomCoords[segIdx * 2];
      const y0 = ds.geomCoords[segIdx * 2 + 1];
      const x1 = ds.geomCoords[(segIdx + 1) * 2];
      const y1 = ds.geomCoords[(segIdx + 1) * 2 + 1];
      lon = x0 + (x1 - x0) * localT;
      lat = y0 + (y1 - y0) * localT;
      segDx = x1 - x0;
      segDy = y1 - y0;
      // Ground follows the road's own vertices (sampled from the drawn terrain), not just its end nodes.
      const g0 = this.groundAt(segIdx, elevSrc + (elevDst - elevSrc) * f0, tEnabled, tExag);
      const g1 = this.groundAt(segIdx + 1, elevSrc + (elevDst - elevSrc) * f1, tEnabled, tExag);
      ground = g0 + (g1 - g0) * localT;
    } else if (endPt - startPt === 1) {
      lon = ds.geomCoords[startPt * 2];
      lat = ds.geomCoords[startPt * 2 + 1];
      ground = this.groundAt(startPt, elevSrc, tEnabled, tExag);
    }

    // Separate sidewalk channel for pedestrians (right-hand perpendicular offset)
    if (modeIdx === 0) {
      const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      const mPerDegLon = 111320 * cosLat;
      const mPerDegLat = 110540;
      const dxM = segDx * mPerDegLon;
      const dyM = segDy * mPerDegLat;
      const segLenM = Math.hypot(dxM, dyM);
      if (segLenM > 0.25) {
        lon += ((dyM / segLenM) * SIDEWALK_OFFSET_M) / mPerDegLon;
        lat += ((-dxM / segLenM) * SIDEWALK_OFFSET_M) / mPerDegLat;
      }
    }

    const z = ground + PARTICLE_LIFT_M;

    const pOff = slot * 3;
    this.positions[pOff] = lon;
    this.positions[pOff + 1] = lat;
    this.positions[pOff + 2] = z;

    const modeId = MOBILITY_MODES_ORDER[modeIdx];
    const cOff = slot * 4;

    if (!params.enabledModes[modeId]) {
      this.colors[cOff + 3] = 0;
      this.radii[slot] = 0;
      return;
    }

    if (params.colorMode === 'speed') {
      if (modeIdx === 0) {
        this.colors[cOff] = 226;
        this.colors[cOff + 1] = 232;
        this.colors[cOff + 2] = 240;
      } else {
        const effMult = this.getEffectiveEdgeMult(
          modeIdx,
          edgeId,
          params.congestionEnabled ?? true
        );
        const speedRatio = 1.0 / Math.max(1.0, effMult);
        if (speedRatio >= 0.8) {
          this.colors[cOff] = 16;
          this.colors[cOff + 1] = 185;
          this.colors[cOff + 2] = 129;
        } else if (speedRatio >= 0.5) {
          const t = (speedRatio - 0.5) / 0.3;
          this.colors[cOff] = Math.round(245 + (16 - 245) * t);
          this.colors[cOff + 1] = Math.round(158 + (185 - 158) * t);
          this.colors[cOff + 2] = Math.round(11 + (129 - 11) * t);
        } else {
          const t = Math.max(0, Math.min(1, (speedRatio - 0.2) / 0.3));
          this.colors[cOff] = Math.round(239 + (245 - 239) * t);
          this.colors[cOff + 1] = Math.round(68 + (158 - 68) * t);
          this.colors[cOff + 2] = Math.round(68 + (11 - 68) * t);
        }
      }
    } else {
      const modeColor =
        ds.meta.modes[modeIdx]?.color ?? MOBILITY_MODE_COLORS[modeId];
      this.colors[cOff] = modeColor[0];
      this.colors[cOff + 1] = modeColor[1];
      this.colors[cOff + 2] = modeColor[2];
    }

    const opacity = Math.max(0, Math.min(1, params.opacity));
    const baseRadius = MODE_BASE_RADIUS[modeIdx] ?? 2.8;

    if (selectedZoneIdx >= 0 && params.barangayFilter !== 'all') {
      const isOut = this.agentOrigZone[slot] === selectedZoneIdx;
      const isIn = this.agentDestZone[slot] === selectedZoneIdx;
      const matches =
        params.barangayFilter === 'from'
          ? isOut
          : params.barangayFilter === 'to'
            ? isIn
            : isOut || isIn;

      if (matches) {
        // Outbound trips glow orange, inbound cyan, so From / To / Both look different on the map.
        const hue = isOut && !isIn ? [249, 115, 22] : isIn && !isOut ? [34, 211, 238] : [250, 204, 21];
        this.colors[cOff] = hue[0];
        this.colors[cOff + 1] = hue[1];
        this.colors[cOff + 2] = hue[2];
        this.colors[cOff + 3] = 255;
        this.radii[slot] = baseRadius * 2.2;
      } else {
        this.colors[cOff + 3] = Math.round(10 * opacity);
        this.radii[slot] = 1;
      }
    } else {
      this.colors[cOff + 3] = Math.round(230 * opacity);
      this.radii[slot] = baseRadius;
    }
  }

  private resolveZoneIndex(name: string | null): number {
    if (!name) return -1;
    const idx = this.zoneNameToIdx.get(name.trim().toLowerCase());
    return idx !== undefined ? idx : -1;
  }

  /**
   * Advance all active agents by `dtRealSec * simSpeed` simulated seconds
   * without any per-frame heap allocations in steady state.
   */
  step(
    dtRealSec: number,
    simSpeed: number,
    timeHours: number,
    params: MobilitySimParams
  ): MobilitySimStats {
    const perfStart = performance.now();
    const spawnsStart = this.spawnCounter;
    const diurnal = getDiurnalState(timeHours);
    this.lastDiurnal = diurnal;
    this.simHours = timeHours;
    const congestionEnabled = params.congestionEnabled ?? true;

    const targetAgents = Math.max(0, Math.min(MAX_AGENTS, Math.round(params.targetAgents)));
    const desiredActive = Math.max(
      0,
      Math.min(MAX_AGENTS, Math.round(targetAgents * diurnal.intensity))
    );

    const betaChanged =
      (this.lastBetaScale !== null &&
        Math.abs(params.betaScale - this.lastBetaScale) > 1e-4) ||
      this.gravityParamsChanged(params);
    this.lastBetaScale = params.betaScale;

    if (betaChanged) {
      for (let i = 0; i < desiredActive; i += 1) {
        this.spawnAgent(i, diurnal, params.betaScale, true, congestionEnabled);
      }
    } else if (desiredActive > this.activeDrawCount) {
      for (let i = this.activeDrawCount; i < desiredActive; i += 1) {
        this.spawnAgent(i, diurnal, params.betaScale, true, congestionEnabled);
      }
    }
    this.activeDrawCount = desiredActive;

    for (let i = 0; i < this.activeDrawCount; i += 1) {
      if (!this.agentActive[i]) {
        this.spawnAgent(i, diurnal, params.betaScale, true, congestionEnabled);
      }
    }

    const dtSimSec = Math.max(0, dtRealSec) * Math.max(0, simSpeed);
    this.tallySimSec += dtSimSec;
    // The all-edge BPR/EMA pass is the costly part: run it every few steps with the
    // accumulated simulated time so the smoothing stays correct.
    this.congAccumDtSec += dtSimSec;
    this.congStepCounter += 1;
    if (
      this.congStepCounter % CONGESTION_EVERY_N_STEPS === 1 ||
      !this.hasCongestionInit ||
      !(params.congestionEnabled ?? true)
    ) {
      this.lastCongestion = this.updateCongestionField(
        this.congAccumDtSec,
        diurnal.intensity,
        params
      );
      this.congAccumDtSec = 0;
    }
    if (
      (params.congestionEnabled ?? true) &&
      this.congStepCounter % REROUTE_EVERY_N_STEPS === 0
    ) {
      this.refreshRoutingTree();
    }
    const { congestedEdgeCount, peakVcRatio } = this.lastCongestion;

    const nEdges = this.dataset.nEdges;
    const t0 = this.dataset.edgeT0Sec;
    const selectedZoneIdx = this.resolveZoneIndex(params.selectedBarangayName);

    let activeCount = 0;
    let totalTravellers = 0;
    let tripMinSum = 0;
    let tripKmSum = 0;
    let intraCount = 0;
    let motoMultSum = 0;
    let motoAgentCount = 0;
    let outCount = 0;
    let selHbw = 0;
    let selHbe = 0;
    let selHbo = 0;
    let inCount = 0;
    let cWalk = 0;
    let cMoto = 0;
    let cTrike = 0;
    let cCar = 0;
    let cPuv = 0;
    let tWalk = 0;
    let tMoto = 0;
    let tTrike = 0;
    let tCar = 0;
    let tPuv = 0;
    let pHbw = 0;
    let pHbe = 0;
    let pHbo = 0;

    for (let i = 0; i < this.activeDrawCount; i += 1) {
      let route = this.agentRoutes[i];
      if (!this.agentActive[i] || !route || route.length === 0) {
        this.colors[i * 4 + 3] = 0;
        this.radii[i] = 0;
        continue;
      }

      if (dtSimSec > 0) {
        const modeIdx = this.agentMode[i];
        let cursor = this.agentEdgeCursor[i];
        let edgeElapsed = this.agentEdgeElapsedSec[i];
        let remRealDt = dtSimSec;
        let finished = false;
        let freeConsumed = 0;

        while (cursor < route.length && remRealDt > 0) {
          const eid = route[cursor];
          const freeDur = Math.max(0.05, t0[modeIdx * nEdges + eid]);
          const mult = this.getEffectiveEdgeMult(modeIdx, eid, congestionEnabled);
          const remFreeNeeded = freeDur - edgeElapsed;
          const freeAdvance = remRealDt / mult;

          if (freeAdvance < remFreeNeeded) {
            edgeElapsed += freeAdvance;
            freeConsumed += freeAdvance;
            remRealDt = 0;
            break;
          }
          remRealDt -= remFreeNeeded * mult;
          freeConsumed += remFreeNeeded;
          edgeElapsed = 0;
          cursor += 1;
          if (cursor >= route.length) {
            finished = true;
            break;
          }
        }

        if (finished) {
          this.spawnAgent(i, diurnal, params.betaScale, false, congestionEnabled);
          route = this.agentRoutes[i];
          if (!this.agentActive[i] || !route || route.length === 0) {
            this.colors[i * 4 + 3] = 0;
            this.radii[i] = 0;
            continue;
          }
        } else {
          this.agentEdgeCursor[i] = cursor;
          this.agentEdgeElapsedSec[i] = edgeElapsed;
          this.agentTotalElapsedSec[i] = Math.min(
            this.agentTotalDurSec[i],
            this.agentTotalElapsedSec[i] + freeConsumed
          );
        }
      }

      this.writeAgentPositionAndVisuals(i, params, selectedZoneIdx);

      const m = this.agentMode[i];
      const pax = Math.max(1, this.agentPassengers[i] || 1);
      const activeCursor = Math.min(route.length - 1, this.agentEdgeCursor[i]);
      const effMult = this.getEffectiveEdgeMult(
        m,
        route[activeCursor],
        congestionEnabled
      );

      activeCount += 1;
      totalTravellers += pax;
      tripMinSum += (this.agentTotalDurSec[i] * effMult) / 60;
      tripKmSum += this.agentTotalDistKm[i];
      if (this.agentOrigZone[i] === this.agentDestZone[i]) intraCount += 1;

      if (this.modeCongests[m]) {
        motoMultSum += effMult;
        motoAgentCount += 1;
      }

      if (m === 0) {
        cWalk += 1;
        tWalk += pax;
      } else if (m === 1) {
        cMoto += 1;
        tMoto += pax;
      } else if (m === 2) {
        cTrike += 1;
        tTrike += pax;
      } else if (m === 3) {
        cCar += 1;
        tCar += pax;
      } else {
        cPuv += 1;
        tPuv += pax;
      }

      const p = this.agentPurpose[i];
      if (p === 0) pHbw += 1;
      else if (p === 1) pHbe += 1;
      else pHbo += 1;

      if (selectedZoneIdx >= 0) {
        if (this.agentOrigZone[i] === selectedZoneIdx) outCount += 1;
        // Purpose mix by where the traveller lives: the home end of the trip, outbound or return.
        const homeZone =
          this.agentOrigRole[i] === ROLE_INDEX.home ? this.agentOrigZone[i] : this.agentDestZone[i];
        if (homeZone === selectedZoneIdx) {
          const pp = this.agentPurpose[i];
          if (pp === 0) selHbw += 1;
          else if (pp === 1) selHbe += 1;
          else selHbo += 1;
        }
        if (this.agentDestZone[i] === selectedZoneIdx) inCount += 1;
      }
    }

    this.prevTotalTravellers = totalTravellers;
    const travelTimeIndex = motoAgentCount > 0 ? motoMultSum / motoAgentCount : 1.0;

    this.lastStats = {
      activeAgents: activeCount,
      targetAgents,
      totalTravellers,
      phaseLabel: diurnal.phaseLabel,
      modeCounts: {
        walk: cWalk,
        motorcycle: cMoto,
        tricycle: cTrike,
        car: cCar,
        puv: cPuv,
      },
      modeTravellers: {
        walk: tWalk,
        motorcycle: tMoto,
        tricycle: tTrike,
        car: tCar,
        puv: tPuv,
      },
      purposeCounts: {
        hbw: pHbw,
        hbe: pHbe,
        hbo: pHbo,
      },
      avgTripMin: activeCount > 0 ? tripMinSum / activeCount : 0,
      avgTripKm: activeCount > 0 ? tripKmSum / activeCount : 0,
      stepMs: 0,
      spawnsPerStep: 0,
      intraZoneShare: activeCount > 0 ? intraCount / activeCount : 0,
      avgSpeedRatio: 1.0 / Math.max(1.0, travelTimeIndex),
      travelTimeIndex,
      congestedEdgeCount,
      peakVcRatio,
      selectedBarangayOutbound: outCount,
      selectedBarangayPurposes: { hbw: selHbw, hbe: selHbe, hbo: selHbo },
      selectedBarangayInbound: inCount,
      loaded: true,
    };

    this.lastStats.stepMs = performance.now() - perfStart;
    this.lastStats.spawnsPerStep = this.spawnCounter - spawnsStart;
    return this.lastStats;
  }

  /**
   * Re-evaluate colors, radii, elevations, and stats without advancing simulation time.
   */
  refreshVisuals(
    params: MobilitySimParams,
    timeHours?: number
  ): MobilitySimStats {
    if (timeHours !== undefined) {
      this.lastDiurnal = getDiurnalState(timeHours);
    }
    const congestionEnabled = params.congestionEnabled ?? true;
    const targetAgents = Math.max(0, Math.min(MAX_AGENTS, Math.round(params.targetAgents)));
    const desiredActive = Math.max(
      0,
      Math.min(MAX_AGENTS, Math.round(targetAgents * this.lastDiurnal.intensity))
    );

    const betaChanged =
      (this.lastBetaScale !== null &&
        Math.abs(params.betaScale - this.lastBetaScale) > 1e-4) ||
      this.gravityParamsChanged(params);
    this.lastBetaScale = params.betaScale;

    if (betaChanged) {
      for (let i = 0; i < desiredActive; i += 1) {
        this.spawnAgent(i, this.lastDiurnal, params.betaScale, true, congestionEnabled);
      }
    } else if (desiredActive > this.activeDrawCount) {
      for (let i = this.activeDrawCount; i < desiredActive; i += 1) {
        this.spawnAgent(i, this.lastDiurnal, params.betaScale, true, congestionEnabled);
      }
    }
    this.activeDrawCount = desiredActive;

    for (let i = 0; i < this.activeDrawCount; i += 1) {
      if (!this.agentActive[i]) {
        this.spawnAgent(i, this.lastDiurnal, params.betaScale, true, congestionEnabled);
      }
    }

    const { congestedEdgeCount, peakVcRatio } = this.updateCongestionField(
      0,
      this.lastDiurnal.intensity,
      params
    );

    const selectedZoneIdx = this.resolveZoneIndex(params.selectedBarangayName);

    let activeCount = 0;
    let totalTravellers = 0;
    let tripMinSum = 0;
    let tripKmSum = 0;
    let intraCount = 0;
    let motoMultSum = 0;
    let motoAgentCount = 0;
    let outCount = 0;
    let selHbw = 0;
    let selHbe = 0;
    let selHbo = 0;
    let inCount = 0;
    let cWalk = 0;
    let cMoto = 0;
    let cTrike = 0;
    let cCar = 0;
    let cPuv = 0;
    let tWalk = 0;
    let tMoto = 0;
    let tTrike = 0;
    let tCar = 0;
    let tPuv = 0;
    let pHbw = 0;
    let pHbe = 0;
    let pHbo = 0;

    for (let i = 0; i < this.activeDrawCount; i += 1) {
      const route = this.agentRoutes[i];
      if (!this.agentActive[i] || !route || route.length === 0) {
        this.colors[i * 4 + 3] = 0;
        this.radii[i] = 0;
        continue;
      }
      this.writeAgentPositionAndVisuals(i, params, selectedZoneIdx);

      const m = this.agentMode[i];
      const pax = Math.max(1, this.agentPassengers[i] || 1);
      const activeCursor = Math.min(route.length - 1, this.agentEdgeCursor[i]);
      const effMult = this.getEffectiveEdgeMult(
        m,
        route[activeCursor],
        congestionEnabled
      );

      activeCount += 1;
      totalTravellers += pax;
      tripMinSum += (this.agentTotalDurSec[i] * effMult) / 60;
      tripKmSum += this.agentTotalDistKm[i];
      if (this.agentOrigZone[i] === this.agentDestZone[i]) intraCount += 1;

      if (this.modeCongests[m]) {
        motoMultSum += effMult;
        motoAgentCount += 1;
      }

      if (m === 0) {
        cWalk += 1;
        tWalk += pax;
      } else if (m === 1) {
        cMoto += 1;
        tMoto += pax;
      } else if (m === 2) {
        cTrike += 1;
        tTrike += pax;
      } else if (m === 3) {
        cCar += 1;
        tCar += pax;
      } else {
        cPuv += 1;
        tPuv += pax;
      }

      const p = this.agentPurpose[i];
      if (p === 0) pHbw += 1;
      else if (p === 1) pHbe += 1;
      else pHbo += 1;

      if (selectedZoneIdx >= 0) {
        if (this.agentOrigZone[i] === selectedZoneIdx) outCount += 1;
        // Purpose mix by where the traveller lives: the home end of the trip, outbound or return.
        const homeZone =
          this.agentOrigRole[i] === ROLE_INDEX.home ? this.agentOrigZone[i] : this.agentDestZone[i];
        if (homeZone === selectedZoneIdx) {
          const pp = this.agentPurpose[i];
          if (pp === 0) selHbw += 1;
          else if (pp === 1) selHbe += 1;
          else selHbo += 1;
        }
        if (this.agentDestZone[i] === selectedZoneIdx) inCount += 1;
      }
    }

    this.prevTotalTravellers = totalTravellers;
    const travelTimeIndex = motoAgentCount > 0 ? motoMultSum / motoAgentCount : 1.0;

    this.lastStats = {
      activeAgents: activeCount,
      targetAgents,
      totalTravellers,
      phaseLabel: this.lastDiurnal.phaseLabel,
      modeCounts: {
        walk: cWalk,
        motorcycle: cMoto,
        tricycle: cTrike,
        car: cCar,
        puv: cPuv,
      },
      modeTravellers: {
        walk: tWalk,
        motorcycle: tMoto,
        tricycle: tTrike,
        car: tCar,
        puv: tPuv,
      },
      purposeCounts: {
        hbw: pHbw,
        hbe: pHbe,
        hbo: pHbo,
      },
      avgTripMin: activeCount > 0 ? tripMinSum / activeCount : 0,
      avgTripKm: activeCount > 0 ? tripKmSum / activeCount : 0,
      stepMs: 0,
      spawnsPerStep: 0,
      intraZoneShare: activeCount > 0 ? intraCount / activeCount : 0,
      avgSpeedRatio: 1.0 / Math.max(1.0, travelTimeIndex),
      travelTimeIndex,
      congestedEdgeCount,
      peakVcRatio,
      selectedBarangayOutbound: outCount,
      selectedBarangayPurposes: { hbw: selHbw, hbe: selHbe, hbo: selHbo },
      selectedBarangayInbound: inCount,
      loaded: true,
    };

    return this.lastStats;
  }

  /**
   * Extract the most congested carriageway road links above `minVc` for PathLayer overlay.
   */
  getCongestedEdges(
    terrainEnabled: boolean,
    terrainExaggeration: number,
    minVc = 0.55,
    maxSegments = 800
  ): CongestedEdgeSegment[] {
    if (!this.hasCongestionInit) return [];

    const ds = this.dataset;
    const candidates: Array<{ edgeId: number; vc: number }> = [];
    for (let e = 0; e < ds.nEdges; e += 1) {
      const vc = this.edgeVcRatio[e];
      if (vc >= minVc) {
        candidates.push({ edgeId: e, vc });
      }
    }
    if (candidates.length === 0) return [];

    candidates.sort((a, b) => b.vc - a.vc);
    const limit = Math.min(maxSegments, candidates.length);
    const out: CongestedEdgeSegment[] = [];

    for (let k = 0; k < limit; k += 1) {
      const { edgeId, vc } = candidates[k];
      const startPt = ds.geomOffs[edgeId];
      const endPt = ds.geomOffs[edgeId + 1];
      const elevSrc = ds.nodeElev[ds.edgeSrc[edgeId]];
      const elevDst = ds.nodeElev[ds.edgeDst[edgeId]];
      const path: [number, number, number][] = [];

      if (endPt - startPt >= 2) {
        for (let pt = startPt; pt < endPt; pt += 1) {
          const frac = ds.ptCumFrac[pt];
          const z = this.groundAt(pt, elevSrc + (elevDst - elevSrc) * frac, terrainEnabled, terrainExaggeration) + PATH_LIFT_M;
          path.push([ds.geomCoords[pt * 2], ds.geomCoords[pt * 2 + 1], z]);
        }
      } else {
        const z0 = (terrainEnabled ? elevSrc * terrainExaggeration : 0) + PATH_LIFT_M;
        const z1 = (terrainEnabled ? elevDst * terrainExaggeration : 0) + PATH_LIFT_M;
        path.push([ds.nodeLon[ds.edgeSrc[edgeId]], ds.nodeLat[ds.edgeSrc[edgeId]], z0]);
        path.push([ds.nodeLon[ds.edgeDst[edgeId]], ds.nodeLat[ds.edgeDst[edgeId]], z1]);
      }

      if (path.length >= 2) {
        out.push({ path, vc });
      }
    }

    return out;
  }

  /**
   * Build detailed traveller telemetry and full 3D route polyline for inspection.
   */
  getAgentInfo(
    agentIndex: number,
    terrainEnabled: boolean,
    terrainExaggeration: number,
    congestionEnabled = true,
    expectedSerial?: number
  ): SelectedAgentInfo | null {
    if (
      agentIndex < 0 ||
      agentIndex >= this.activeDrawCount ||
      !this.agentActive[agentIndex]
    ) {
      return null;
    }
    if (
      expectedSerial !== undefined &&
      this.agentTripSerial[agentIndex] !== expectedSerial
    ) {
      return null;
    }

    const ds = this.dataset;
    const route = this.agentRoutes[agentIndex];
    if (!route || route.length === 0) return null;

    const origZone =
      ds.meta.zones[this.agentOrigZone[agentIndex]]?.name ?? 'Unknown';
    const destZone =
      ds.meta.zones[this.agentDestZone[agentIndex]]?.name ?? 'Unknown';
    const purposeIdx = this.agentPurpose[agentIndex];
    const purpose: MobilityPurposeId = PURPOSE_IDS[purposeIdx] ?? 'hbw';
    const modeIdx = this.agentMode[agentIndex];
    const mode: MobilityModeId = MOBILITY_MODES_ORDER[modeIdx] ?? 'car';

    const distanceKm = this.agentTotalDistKm[agentIndex];
    const totalFreeDurSec = this.agentTotalDurSec[agentIndex];
    const totalElapsedFreeSec = this.agentTotalElapsedSec[agentIndex];

    const activeCursor = Math.min(route.length - 1, this.agentEdgeCursor[agentIndex]);
    const currentEdgeId = route[activeCursor];
    const curMult = this.getEffectiveEdgeMult(
      modeIdx,
      currentEdgeId,
      congestionEnabled
    );

    const freeDurationMin = totalFreeDurSec / 60;
    const freeFlowSpeedKmh =
      freeDurationMin > 0 ? distanceKm / (freeDurationMin / 60) : 0;
    const speedKmh = freeFlowSpeedKmh / Math.max(1.0, curMult);

    let estRemainingSec = 0;
    const t0Base = modeIdx * ds.nEdges;
    for (let k = activeCursor; k < route.length; k += 1) {
      const eid = route[k];
      const freeEdge = Math.max(0.05, ds.edgeT0Sec[t0Base + eid]);
      const remFree =
        k === activeCursor
          ? Math.max(0, freeEdge - this.agentEdgeElapsedSec[agentIndex])
          : freeEdge;
      estRemainingSec +=
        remFree * this.getEffectiveEdgeMult(modeIdx, eid, congestionEnabled);
    }

    const durationMin = Math.max(freeDurationMin, (totalElapsedFreeSec + estRemainingSec) / 60);
    const progressPct =
      totalFreeDurSec > 0
        ? Math.max(0, Math.min(100, (totalElapsedFreeSec / totalFreeDurSec) * 100))
        : 0;
    const etaMin = Math.max(0, estRemainingSec / 60);

    const passengers = Math.max(1, this.agentPassengers[agentIndex] || 1);
    const pcu = this.modePcu[modeIdx] ?? 0;
    const currentLinkVc = this.modeCongests[modeIdx]
      ? this.edgeVcRatio[currentEdgeId] ?? 0
      : 0;
    const channel: 'carriageway' | 'sidewalk' =
      mode === 'walk' ? 'sidewalk' : 'carriageway';

    const origRefForPath = this.describeBuilding(
      this.agentOrigBldg[agentIndex],
      ROLES[this.agentOrigRole[agentIndex]] ?? 'home'
    );
    const destRefForPath = this.describeBuilding(
      this.agentDestBldg[agentIndex],
      ROLES[this.agentDestRole[agentIndex]] ?? 'other'
    );
    const routePath: [number, number, number][] = [];
    for (let i = 0; i < route.length; i += 1) {
      const edgeId = route[i];
      const startPt = ds.geomOffs[edgeId];
      const endPt = ds.geomOffs[edgeId + 1];
      const elevSrc = ds.nodeElev[ds.edgeSrc[edgeId]];
      const elevDst = ds.nodeElev[ds.edgeDst[edgeId]];

      if (endPt - startPt >= 1) {
        for (let pt = startPt; pt < endPt; pt += 1) {
          const frac = ds.ptCumFrac[pt];
          const z = this.groundAt(pt, elevSrc + (elevDst - elevSrc) * frac, terrainEnabled, terrainExaggeration) + PATH_LIFT_M;
          const lon = ds.geomCoords[pt * 2];
          const lat = ds.geomCoords[pt * 2 + 1];

          const prev = routePath[routePath.length - 1];
          if (
            !prev ||
            Math.abs(prev[0] - lon) > 1e-7 ||
            Math.abs(prev[1] - lat) > 1e-7
          ) {
            routePath.push([lon, lat, z]);
          }
        }
      } else {
        const z = (terrainEnabled ? elevSrc * terrainExaggeration : 0) + PATH_LIFT_M;
        routePath.push([
          ds.nodeLon[ds.edgeSrc[edgeId]],
          ds.nodeLat[ds.edgeSrc[edgeId]],
          z,
        ]);
      }
    }

    if (origRefForPath && routePath.length > 0) {
      routePath.unshift([origRefForPath.lon, origRefForPath.lat, routePath[0][2]]);
    }
    if (destRefForPath && routePath.length > 0) {
      routePath.push([destRefForPath.lon, destRefForPath.lat, routePath[routePath.length - 1][2]]);
    }

    const sampleScale = this.lastSampleScale;
    const elapsedFreeMin = totalElapsedFreeSec / 60;
    const elapsedHours =
      (((this.simHours - this.agentDepartHours[agentIndex]) % 24) + 24) % 24;
    const elapsedMin = Math.max(elapsedFreeMin, elapsedHours * 60);
    const delayMin = Math.max(0, elapsedMin - elapsedFreeMin);
    const distanceTravelledKm = distanceKm * (progressPct / 100);
    const firstEdge = route[0];
    const lastEdge = route[route.length - 1];
    const originNode = ds.edgeSrc[firstEdge];
    const destNode = ds.edgeDst[lastEdge];
    const origRef = origRefForPath;
    const destRef = destRefForPath;

    const pOff = agentIndex * 3;
    return {
      tripSerial: this.agentTripSerial[agentIndex],
      sampleScale,
      representedTravellers: passengers * sampleScale,
      departHours: this.agentDepartHours[agentIndex],
      elapsedMin,
      delayMin,
      distanceTravelledKm,
      distanceRemainingKm: Math.max(0, distanceKm - distanceTravelledKm),
      linkIndex: activeCursor + 1,
      linkCount: route.length,
      originCoords: origRef ? [origRef.lon, origRef.lat] : [ds.nodeLon[originNode], ds.nodeLat[originNode]],
      destCoords: destRef ? [destRef.lon, destRef.lat] : [ds.nodeLon[destNode], ds.nodeLat[destNode]],
      originBuilding: origRef,
      destBuilding: destRef,
      agentId: agentIndex,
      originZone: origZone,
      destZone: destZone,
      purpose,
      purposeLabel: MOBILITY_PURPOSE_LABELS[purpose],
      mode,
      modeLabel: ds.meta.modes[modeIdx]?.name ?? MOBILITY_MODE_LABELS[mode],
      passengers,
      pcu,
      freeFlowSpeedKmh,
      speedKmh,
      currentLinkVc,
      channel,
      distanceKm,
      durationMin,
      progressPct,
      etaMin,
      coordinates: [this.positions[pOff], this.positions[pOff + 1]],
      routePath,
    };
  }

  /** Live 3D position of an agent slot (for follow camera / highlight ring). */
  getAgentPosition(
    agentIndex: number,
    expectedSerial?: number
  ): [number, number, number] | null {
    if (
      agentIndex < 0 ||
      agentIndex >= this.activeDrawCount ||
      !this.agentActive[agentIndex]
    ) {
      return null;
    }
    if (
      expectedSerial !== undefined &&
      this.agentTripSerial[agentIndex] !== expectedSerial
    ) {
      return null;
    }
    const o = agentIndex * 3;
    return [this.positions[o], this.positions[o + 1], this.positions[o + 2]];
  }
}
