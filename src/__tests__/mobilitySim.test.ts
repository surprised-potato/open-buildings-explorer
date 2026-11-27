import { describe, expect, it } from 'vitest';
import { mobilityLayer } from '../layers/builtins/mobilityLayer';
import {
  MOBILITY_BINARY_MAGIC,
  MOBILITY_BINARY_VERSION,
  parseMobilityBuildings,
  parseMobilityDataset,
} from '../utils/mobilityLoader';
import {
  buildGravityCdf,
  buildGravityModel,
  zoneProduction,
  getDiurnalState,
  MAX_AGENTS,
  MobilitySimulation,
} from '../utils/mobilitySim';
import type {
  MobilityDataset,
  MobilitySimParams,
  MobilityZonesMetadata,
} from '../utils/mobilityTypes';

function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Construct a small synthetic 4-node, 5-edge, 2-zone mobility binary + metadata:
 * Nodes:
 *   0: [122.940, 10.670, 10m] (Zone 0 access node)
 *   1: [122.945, 10.670, 15m] (Zone 0 hub node)
 *   2: [122.950, 10.672, 20m] (Bridge node)
 *   3: [122.955, 10.675, 25m] (Zone 1 hub & access node)
 * Edges (5 total -> odd count tests 4-byte Uint16 padding):
 *   0: 0 -> 1 (curved 3-pt polyline)
 *   1: 1 -> 0 (reverse spur, used to test loop trimming 0->1->0->2)
 *   2: 0 -> 2 (curved 3-pt polyline)
 *   3: 2 -> 3
 *   4: 3 -> 1 (return link to Zone 0 hub)
 */
function createSyntheticMobilityFixture(
  binaryVersion: 1 | 2 = MOBILITY_BINARY_VERSION as 2,
  capacityValues: number[] = [1000, 1000, 1000, 1000, 1000]
): {
  buffer: ArrayBuffer;
  meta: MobilityZonesMetadata;
} {
  const nNodes = 4;
  const nEdges = 5;
  const nZones = 2;
  const nProfiles = 3;

  const nodeLon = [122.94, 122.945, 122.95, 122.955];
  const nodeLat = [10.67, 10.67, 10.672, 10.675];
  const nodeElev = [10, 15, 20, 25];

  const edgeSrc = [0, 1, 0, 2, 3];
  const edgeDst = [1, 0, 2, 3, 1];
  const edgeLenKm = [0.6, 0.6, 1.2, 0.8, 1.8];

  // Curved geometry for edges 0 and 2 (3 points each), 2 points for others -> 12 pts
  const edgePolylines: Array<Array<[number, number]>> = [
    [
      [122.94, 10.67],
      [122.9425, 10.6715],
      [122.945, 10.67],
    ],
    [
      [122.945, 10.67],
      [122.94, 10.67],
    ],
    [
      [122.94, 10.67],
      [122.945, 10.6725],
      [122.95, 10.672],
    ],
    [
      [122.95, 10.672],
      [122.955, 10.675],
    ],
    [
      [122.955, 10.675],
      [122.945, 10.67],
    ],
  ];

  const geomOffs: number[] = [0];
  const geomCoords: number[] = [];
  for (const pts of edgePolylines) {
    for (const [lon, lat] of pts) {
      geomCoords.push(lon, lat);
    }
    geomOffs.push(geomCoords.length / 2);
  }
  const nPts = geomCoords.length / 2;

  // 5 modes: walk, motorcycle, tricycle, car, puv (seconds per edge)
  const modeSpeedKmh = [4.5, 36, 20, 42, 24];
  const edgeT0Sec = new Float32Array(5 * nEdges);
  for (let m = 0; m < 5; m += 1) {
    for (let e = 0; e < nEdges; e += 1) {
      edgeT0Sec[m * nEdges + e] = (edgeLenKm[e] / modeSpeedKmh[m]) * 3600;
    }
  }

  // Shortest-path incoming edge trees from each zone hub for all 3 profiles:
  // Zone 0 hub = node 1:
  //   prev[0] = edge 1 (1->0)
  //   prev[1] = 0xFFFF (root)
  //   prev[2] = edge 2 (0->2)
  //   prev[3] = edge 3 (2->3)
  //   Path from hub 1 -> node 3 goes 1 -(e1)-> 0 -(e2)-> 2 -(e3)-> 3!
  //   Combined with access spur 0 -(e0)-> 1, loop 0->1->0 trims cleanly to 0->2->3!
  // Zone 1 hub = node 3:
  //   prev[3] = 0xFFFF (root)
  //   prev[1] = edge 4 (3->1)
  //   prev[0] = edge 1 (1->0)
  //   prev[2] = edge 2 (0->2)
  const fromHubPrevEdge = new Uint16Array(nProfiles * nZones * nNodes).fill(
    0xffff
  );
  for (let p = 0; p < nProfiles; p += 1) {
    const z0Off = (p * nZones + 0) * nNodes;
    fromHubPrevEdge[z0Off + 0] = 1;
    fromHubPrevEdge[z0Off + 1] = 0xffff;
    fromHubPrevEdge[z0Off + 2] = 2;
    fromHubPrevEdge[z0Off + 3] = 3;

    const z1Off = (p * nZones + 1) * nNodes;
    fromHubPrevEdge[z1Off + 0] = 1;
    fromHubPrevEdge[z1Off + 1] = 4;
    fromHubPrevEdge[z1Off + 2] = 2;
    fromHubPrevEdge[z1Off + 3] = 0xffff;
  }

  const hasCapacity = binaryVersion >= 2;
  const totalBytes =
    32 +
    nNodes * 4 * 3 +
    align4(nEdges * 2) * 2 +
    nEdges * 4 +
    (hasCapacity ? nEdges * 4 : 0) +
    5 * nEdges * 4 +
    (nEdges + 1) * 4 +
    2 * nPts * 4 +
    align4(fromHubPrevEdge.length * 2);

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  let off = 0;

  const header = [
    MOBILITY_BINARY_MAGIC,
    binaryVersion,
    nNodes,
    nEdges,
    nPts,
    nZones,
    nProfiles,
    0,
  ];
  for (const h of header) {
    view.setUint32(off, h, true);
    off += 4;
  }

  const writeFloat32 = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i += 1) {
      view.setFloat32(off + i * 4, arr[i], true);
    }
    off += arr.length * 4;
  };
  const writeUint16Padded = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i += 1) {
      view.setUint16(off + i * 2, arr[i], true);
    }
    off += align4(arr.length * 2);
  };
  const writeUint32 = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i += 1) {
      view.setUint32(off + i * 4, arr[i], true);
    }
    off += arr.length * 4;
  };

  writeFloat32(nodeLon);
  writeFloat32(nodeLat);
  writeFloat32(nodeElev);
  writeUint16Padded(edgeSrc);
  writeUint16Padded(edgeDst);
  writeFloat32(edgeLenKm);
  if (hasCapacity) {
    writeFloat32(capacityValues);
  }
  writeFloat32(edgeT0Sec);
  writeUint32(geomOffs);
  writeFloat32(geomCoords);
  writeUint16Padded(fromHubPrevEdge);

  const meta: MobilityZonesMetadata = {
    generated_at: '2026-11-27T00:00:00Z',
    source: 'synthetic-test',
    n_nodes: nNodes,
    n_edges: nEdges,
    n_pts: nPts,
    modes: [
      {
        id: 'walk',
        name: 'Walk',
        color: [248, 250, 252],
        asc: 0,
        beta_cost: -0.04,
        beta_duration: -0.05,
        cost_per_km: 0,
        target_share: 0.18,
        occupancy_min: 1,
        occupancy_max: 1,
        pcu: 0,
        congests: false,
        lane_filter: 0,
      },
      {
        id: 'motorcycle',
        name: 'Motorcycle',
        color: [236, 72, 153],
        asc: -1.8294,
        beta_cost: -0.04,
        beta_duration: -0.05,
        cost_per_km: 3.5,
        target_share: 0.25,
        occupancy_min: 1,
        occupancy_max: 2,
        pcu: 0.4,
        congests: true,
        lane_filter: 0.65,
      },
      {
        id: 'tricycle',
        name: 'Tricycle',
        color: [16, 185, 129],
        asc: -0.8766,
        beta_cost: -0.04,
        beta_duration: -0.05,
        cost_per_km: 8.0,
        target_share: 0.1,
        occupancy_min: 1,
        occupancy_max: 4,
        pcu: 0.6,
        congests: true,
        lane_filter: 1.0,
      },
      {
        id: 'car',
        name: 'Car',
        color: [56, 189, 248],
        asc: -1.0637,
        beta_cost: -0.04,
        beta_duration: -0.05,
        cost_per_km: 9.0,
        target_share: 0.14,
        occupancy_min: 1,
        occupancy_max: 3,
        pcu: 1.0,
        congests: true,
        lane_filter: 1.0,
      },
      {
        id: 'puv',
        name: 'Jeepney / bus',
        color: [245, 158, 11],
        asc: -1.5926,
        beta_cost: -0.04,
        beta_duration: -0.05,
        cost_per_km: 2.4,
        target_share: 0.33,
        occupancy_min: 15,
        occupancy_max: 20,
        pcu: 2.0,
        congests: true,
        lane_filter: 1.0,
      },
    ],
    purposes: {
      hbw: { name: 'Home-work', share: 0.48, beta: 1.3, attr: 'jobs' },
      hbe: { name: 'Home-school', share: 0.35, beta: 1.8, attr: 'students' },
      hbo: { name: 'Home-other', share: 0.17, beta: 1.5, attr: 'commerce' },
    },
    routing_profiles: ['motorized', 'tricycle', 'walk'],
    mode_profile_map: {
      walk: 2,
      motorcycle: 0,
      tricycle: 1,
      car: 0,
      puv: 0,
    },
    zones: [
      {
        idx: 0,
        id: 'zone0',
        name: 'Villamonte',
        centroid: [122.942, 10.67],
        hub_node: 1,
        pop: 12000,
        jobs: 2500,
        students: 1500,
        commerce: 1.0,
        access_nodes: {
          home: [[0, 1]],
          work: [[0, 1]],
          school: [[0, 1]],
          other: [[0, 1]],
        },
        access_spurs: {
          '0': [[0], [0], [0]],
          '1': [[], [], []],
        },
      },
      {
        idx: 1,
        id: 'zone1',
        name: 'Mandalagan',
        centroid: [122.955, 10.675],
        hub_node: 3,
        pop: 8000,
        jobs: 6000,
        students: 4000,
        commerce: 3.0,
        access_nodes: {
          home: [[3, 1]],
          work: [[3, 1]],
          school: [[3, 1]],
          other: [[3, 1]],
        },
        access_spurs: {
          '3': [[], [], []],
        },
      },
    ],
  };

  return { buffer, meta };
}

function defaultParams(
  overrides: Partial<MobilitySimParams> = {}
): MobilitySimParams {
  return {
    targetAgents: 200,
    betaScale: 1.0,
    enabledModes: {
      walk: true,
      motorcycle: true,
      tricycle: true,
      car: true,
      puv: true,
    },
    selectedBarangayName: null,
    barangayFilter: 'all',
    terrainEnabled: true,
    terrainExaggeration: 1.5,
    opacity: 1.0,
    ...overrides,
  };
}

describe('mobilityLoader, gravity model, diurnal curve & MobilitySimulation', () => {
  it('parses aligned binary buffer and precomputes curved polyline fractions', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    const ds: MobilityDataset = parseMobilityDataset(buffer, meta);

    expect(ds.nNodes).toBe(4);
    expect(ds.nEdges).toBe(5);
    expect(ds.nPts).toBe(12);
    expect(ds.nZones).toBe(2);
    expect(ds.edgeSrc).toEqual(new Uint16Array([0, 1, 0, 2, 3]));
    expect(ds.edgeDst).toEqual(new Uint16Array([1, 0, 2, 3, 1]));

    // Edge 0 has 3 points -> cumulative fractions [0, ~0.5, 1]
    expect(ds.ptCumFrac[0]).toBe(0);
    expect(ds.ptCumFrac[1]).toBeGreaterThan(0.3);
    expect(ds.ptCumFrac[1]).toBeLessThan(0.7);
    expect(ds.ptCumFrac[2]).toBe(1);
  });

  it('rejects bad magic, unsupported version, or truncated buffers', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();

    const badMagic = buffer.slice(0);
    new DataView(badMagic).setUint32(0, 0x12345678, true);
    expect(() => parseMobilityDataset(badMagic, meta)).toThrow(/magic/i);

    const badVer = buffer.slice(0);
    new DataView(badVer).setUint32(4, 99, true);
    expect(() => parseMobilityDataset(badVer, meta)).toThrow(/version/i);

    const truncated = buffer.slice(0, 40);
    expect(() => parseMobilityDataset(truncated, meta)).toThrow(/Truncated/i);
  });

  it('produces normalized non-negative doubly-constrained gravity CDFs', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    const ds = parseMobilityDataset(buffer, meta);
    const cdf = buildGravityCdf(ds.meta.zones, 'jobs', 1.3);

    expect(cdf.length).toBe(4);
    expect(cdf[0]).toBe(0); // zero diagonal (0 -> 0)
    expect(cdf[1]).toBeGreaterThan(0);
    expect(cdf[2]).toBeGreaterThan(cdf[1]);
    expect(cdf[3]).toBe(1); // zero diagonal (1 -> 1) keeps cumulative at 1
    for (let i = 1; i < cdf.length; i += 1) {
      expect(cdf[i]).toBeGreaterThanOrEqual(cdf[i - 1]);
    }
  });

  it('models 24-hour Bacolod diurnal curve phases and PA/AP reversal', () => {
    const am = getDiurnalState(7.5);
    expect(am.phaseLabel).toBe('AM Rush');
    expect(am.intensity).toBeGreaterThan(0.85);
    expect(am.paShare.hbw).toBeCloseTo(0.85, 2);
    expect(am.paShare.hbe).toBeCloseTo(0.88, 2);
    expect(am.paShare.hbo).toBeCloseTo(0.55, 2);

    const midday = getDiurnalState(12.5);
    expect(midday.phaseLabel).toBe('Midday');
    expect(midday.intensity).toBeGreaterThan(0.45);
    expect(midday.intensity).toBeLessThan(0.7);
    expect(midday.paShare.hbw).toBeCloseTo(0.5, 2);

    const pm = getDiurnalState(17.5);
    expect(pm.phaseLabel).toBe('PM Rush');
    expect(pm.intensity).toBeGreaterThan(0.85);
    expect(pm.paShare.hbw).toBeCloseTo(0.15, 2);
    expect(pm.paShare.hbe).toBeCloseTo(0.12, 2);

    const nightLate = getDiurnalState(23.5);
    expect(nightLate.phaseLabel).toBe('Night');
    expect(nightLate.intensity).toBeGreaterThanOrEqual(0.08);
    expect(nightLate.intensity).toBeLessThanOrEqual(0.16);

    const nightEarly = getDiurnalState(2.0);
    expect(nightEarly.phaseLabel).toBe('Night');
    expect(nightEarly.intensity).toBeLessThanOrEqual(0.15);
  });

  it('trims spur-to-trunk detour loops cleanly', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    const ds = parseMobilityDataset(buffer, meta);
    const sim = new MobilitySimulation(ds, 42);

    // Spur [0] (0->1) + trunk [1 (1->0), 2 (0->2), 3 (2->3)]
    // Loop 0->1->0 is trimmed, leaving [2, 3] (0->2->3)
    const trimmed = sim.assembleLoopTrimmedRoute(0, 0, 3, 0);
    expect(Array.from(trimmed)).toEqual([2, 3]);
  });

  it('tracks trip identity and reports represented travellers for followed agents', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    const ds = parseMobilityDataset(buffer, meta);
    const sim = new MobilitySimulation(ds, 777);
    sim.step(0.5, 10, 7.75, defaultParams());

    const info = sim.getAgentInfo(0, false, 1, true);
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.tripSerial).toBeGreaterThan(0);
    expect(info.sampleScale).toBeGreaterThan(0);
    expect(info.representedTravellers).toBeCloseTo(info.passengers * info.sampleScale, 5);
    expect(info.linkCount).toBeGreaterThanOrEqual(1);
    expect(info.linkIndex).toBeLessThanOrEqual(info.linkCount);
    expect(info.distanceTravelledKm + info.distanceRemainingKm).toBeCloseTo(info.distanceKm, 4);
    expect(info.delayMin).toBeGreaterThanOrEqual(0);

    // Matching serial resolves; a stale serial (agent respawned) does not.
    expect(sim.getAgentInfo(0, false, 1, true, info.tripSerial)).not.toBeNull();
    expect(sim.getAgentInfo(0, false, 1, true, info.tripSerial + 999)).toBeNull();
    expect(sim.getAgentPosition(0, info.tripSerial)).not.toBeNull();
    expect(sim.getAgentPosition(0, info.tripSerial + 999)).toBeNull();
  });

  it('assigns specific origin and destination buildings from the building table', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    const ds = parseMobilityDataset(buffer, meta);

    // 4 buildings: zone 0 -> two at hub node 1, zone 1 -> two at hub node 3
    const n = 4;
    const nZones = 2;
    const nNodes = 4;
    const size = 32 + 4 * (nZones + 1) + 12 * n + 8 + 4 + 4 * 8 + 2 * 3 * nZones * nNodes;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    [0x444c4242, 1, n, nZones, nNodes, 1, 0, 0].forEach((v, i) => dv.setUint32(i * 4, v, true));
    let off = 32;
    [0, 2, 4].forEach((v, i) => dv.setUint32(off + i * 4, v, true));
    off += 12;
    const lons = [122.945, 122.9451, 122.955, 122.9551];
    const lats = [10.6701, 10.6702, 10.6751, 10.6752];
    lons.forEach((v, i) => dv.setFloat32(off + i * 4, v, true));
    off += 16;
    lats.forEach((v, i) => dv.setFloat32(off + i * 4, v, true));
    off += 16;
    [100, 200, 300, 400].forEach((v, i) => dv.setFloat32(off + i * 4, v, true));
    off += 16;
    [1, 1, 3, 3].forEach((v, i) => dv.setUint16(off + i * 2, v, true));
    off += 8;
    off += 4; // cls u8[4]
    for (let k = 0; k < 4; k += 1) {
      for (let i = 0; i < n; i += 1) dv.setUint16(off + i * 2, 640, true);
      off += 8;
    }
    for (let i = 0; i < 3 * nZones * nNodes; i += 1) dv.setUint16(off + i * 2, 0xffff, true);
    expect(off + 2 * 3 * nZones * nNodes).toBe(size);

    ds.buildings = parseMobilityBuildings(
      buf,
      { classes: ['residential'], named: { '2': ['gers-2', 'Test Mall'] } },
      nZones,
      nNodes
    );
    expect(ds.buildings.count).toBe(4);
    expect(Array.from(ds.buildings.zoneOffs)).toEqual([0, 2, 4]);

    const sim = new MobilitySimulation(ds, 31337);
    sim.step(0.5, 10, 7.75, defaultParams());
    let checked = 0;
    for (let i = 0; i < 200; i += 1) {
      const info = sim.getAgentInfo(i, false, 1, true);
      if (!info || !info.originBuilding || !info.destBuilding) continue;
      checked += 1;
      expect(info.originBuilding.bclass).toBe('residential');
      expect(info.originBuilding.areaM2).toBeGreaterThan(0);
      expect(info.destBuilding.index).not.toBe(info.originBuilding.index);
      expect(info.originCoords[0]).toBeCloseTo(info.originBuilding.lon, 5);
      if (info.destBuilding.index === 2) expect(info.destBuilding.name).toBe('Test Mall');
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('builds a doubly-constrained gravity model with skims and returns null without them', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    parseMobilityDataset(buffer, meta);
    expect(buildGravityModel(meta, 1, 3, 0.5)).toBeNull();

    const zones = [0, 1, 2].map((i) => ({
      ...meta.zones[0],
      idx: i,
      centroid: [122.94 + 0.01 * i, 10.67] as [number, number],
      pop: 1000,
      jobs: 100 * (i + 1),
      students: 50,
      commerce: 1,
      nn_km: 1.1,
      bldg_attr: { home: 10, work: 10 * (i + 1), school: 5, other: 5 },
    }));
    const skimMeta = {
      ...meta,
      zones,
      skims: {
        od_km: [
          [0, 1.1, 2.2],
          [1.1, 0, 1.1],
          [2.2, 1.1, 0],
        ],
        od_min: [
          [0, 3, 6],
          [3, 0, 3],
          [6, 3, 0],
        ],
        od_walk_km: [
          [0, 1.1, 2.2],
          [1.1, 0, 1.1],
          [2.2, 1.1, 0],
        ],
      },
    };
    const gm = buildGravityModel(skimMeta, 1, 3, 0.5);
    expect(gm).not.toBeNull();
    if (!gm) return;
    expect(gm.circuity).toBeGreaterThan(0.5);
    for (const pid of ['hbw', 'hbe', 'hbo'] as const) {
      expect(gm.prodCdf[pid][gm.prodCdf[pid].length - 1]).toBeCloseTo(1, 9);
    }
    for (const pid of ['hbw', 'hbe', 'hbo'] as const) {
      expect(gm.zoneWeight[pid].every((w) => w > 0 && Number.isFinite(w))).toBe(true);
    }
    // Attraction-heavy zone 2 gets more weight for work than zone 0 at the same reach
    expect(gm.zoneWeight.hbw[2]).toBeGreaterThan(gm.zoneWeight.hbw[0] * 0.5);
    // Shorter reach changes the balanced weights (model is sensitive to lambda)
    const gm2 = buildGravityModel(skimMeta, 1, 1, 0.5);
    expect(gm2?.zoneWeight.hbw[0]).not.toBeCloseTo(gm.zoneWeight.hbw[0], 6);
  });

  it('production follows the per-purpose prod field and falls back to population', () => {
    const base = { pop: 1000 } as never;
    const zones = [
      { ...(base as object), prod: { hbw: 10, hbe: 90, hbo: 50 } },
      { ...(base as object), prod: { hbw: 90, hbe: 10, hbo: 50 } },
      { ...(base as object) }, // no prod: population x city rate
    ] as never[];
    const hbe = zoneProduction(zones as never, 'hbe');
    expect(hbe[0]).toBeGreaterThan(hbe[1]);
    expect(hbe[2]).toBeCloseTo(1000 * (100 / 2000), 6);
    const plain = zoneProduction([{ pop: 5 }, { pop: 7 }] as never, 'hbw');
    expect(Array.from(plain)).toEqual([5, 7]);
  });

  it('places particles on the sampled terrain surface, with fallbacks', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    const ds = parseMobilityDataset(buffer, meta);
    const sim = new MobilitySimulation(ds, 777);
    const params = defaultParams();
    sim.step(0.5, 10, 7.5, params);
    const zs = () => {
      const slice = sim.getRenderSlice();
      return Array.from({ length: slice.count }, (_, i) => slice.positions[i * 3 + 2]);
    };
    // Terrain drawn at 500 m everywhere: particles sit 1 m above it.
    expect(sim.updateGroundHeights(() => 500, 1.5, [122, 10, 124, 12])).toBeGreaterThan(0);
    sim.refreshVisuals(params, 7.5);
    const onSurface = zs().filter((z) => Math.abs(z - 501) < 1e-3).length;
    expect(onSurface / zs().length).toBeGreaterThan(0.9);
    // MapLibre answers 0 where no tile is loaded: keep the elevation estimate (nodes are >= 10 m here).
    sim.updateGroundHeights(() => 0, 1.5, [122, 10, 124, 12]);
    sim.refreshVisuals(params, 7.5);
    expect(Math.min(...zs())).toBeGreaterThan(15);
    // Samples taken at another exaggeration are not used.
    sim.updateGroundHeights(() => 500, 3, [122, 10, 124, 12]);
    sim.refreshVisuals(params, 7.5);
    expect(zs().every((z) => z < 400)).toBe(true);
  });

  it('steps simulation into TypedArrays, honors mode/barangay filters, and returns getAgentInfo', () => {
    const { buffer, meta } = createSyntheticMobilityFixture();
    const ds = parseMobilityDataset(buffer, meta);
    const sim = new MobilitySimulation(ds, 12345);

    const stats1 = sim.step(0.5, 10, 7.5, defaultParams());
    expect(stats1.loaded).toBe(true);
    expect(stats1.phaseLabel).toBe('AM Rush');
    expect(stats1.activeAgents).toBeGreaterThan(150);
    expect(stats1.activeAgents).toBeLessThanOrEqual(200);
    expect(stats1.avgTripMin).toBeGreaterThan(0);

    const slice = sim.getRenderSlice();
    expect(slice.count).toBe(stats1.activeAgents);
    expect(slice.positions.length).toBe(MAX_AGENTS * 3);
    expect(slice.colors.length).toBe(MAX_AGENTS * 4);
    expect(slice.radii.length).toBe(MAX_AGENTS);

    // Check positions lie within synthetic bounding box and include terrain z > 3
    for (let i = 0; i < slice.count; i += 1) {
      const lon = slice.positions[i * 3];
      const lat = slice.positions[i * 3 + 1];
      const z = slice.positions[i * 3 + 2];
      expect(lon).toBeGreaterThanOrEqual(122.939);
      expect(lon).toBeLessThanOrEqual(122.956);
      expect(lat).toBeGreaterThanOrEqual(10.669);
      expect(lat).toBeLessThanOrEqual(10.676);
      expect(z).toBeGreaterThan(15); // min nodeElev 10 * 1.5 + 1 m lift = 16
      expect(slice.colors[i * 4 + 3]).toBeGreaterThan(200);
      expect(slice.radii[i]).toBeGreaterThan(1.5);
    }

    // Verify all 5 modes are valid keys and total equals activeAgents
    const totalModes = Object.values(stats1.modeCounts).reduce(
      (a, b) => a + b,
      0
    );
    expect(totalModes).toBe(stats1.activeAgents);

    // Advance time and confirm agent positions actually move
    const firstLonBefore = slice.positions[0];
    const firstLatBefore = slice.positions[1];
    sim.step(2.0, 10, 7.5, defaultParams());
    const moved =
      Math.abs(slice.positions[0] - firstLonBefore) > 1e-7 ||
      Math.abs(slice.positions[1] - firstLatBefore) > 1e-7;
    expect(moved).toBe(true);

    // Inspect agent 0
    const info = sim.getAgentInfo(0, true, 1.5);
    expect(info).not.toBeNull();
    expect(info!.agentId).toBe(0);
    expect(['Villamonte', 'Mandalagan']).toContain(info!.originZone);
    expect(['Villamonte', 'Mandalagan']).toContain(info!.destZone);
    expect(info!.originZone).not.toBe(info!.destZone);
    expect(info!.distanceKm).toBeGreaterThan(0);
    expect(info!.durationMin).toBeGreaterThan(0);
    expect(info!.speedKmh).toBeGreaterThan(0);
    expect(info!.routePath.length).toBeGreaterThanOrEqual(2);
    expect(sim.getAgentInfo(99999, true, 1.5)).toBeNull();

    // Disable all modes -> alpha=0 and radius=0
    sim.refreshVisuals(
      defaultParams({
        enabledModes: {
          walk: false,
          motorcycle: false,
          tricycle: false,
          car: false,
          puv: false,
        },
      })
    );
    for (let i = 0; i < slice.count; i += 1) {
      expect(slice.colors[i * 4 + 3]).toBe(0);
      expect(slice.radii[i]).toBe(0);
    }

    // Barangay O/D filter ('from' Villamonte): matching agents boosted, others dimmed to ~18
    const filteredStats = sim.refreshVisuals(
      defaultParams({
        selectedBarangayName: 'Villamonte',
        barangayFilter: 'from',
      })
    );
    expect(filteredStats.selectedBarangayOutbound).toBeGreaterThan(0);
    expect(filteredStats.selectedBarangayInbound).toBeGreaterThan(0);

    let boostedCount = 0;
    let dimmedCount = 0;
    for (let i = 0; i < slice.count; i += 1) {
      const a = slice.colors[i * 4 + 3];
      if (a >= 240) boostedCount += 1;
      else if (a <= 20) dimmedCount += 1;
    }
    expect(boostedCount).toBe(filteredStats.selectedBarangayOutbound);
    expect(dimmedCount).toBe(
      filteredStats.activeAgents - filteredStats.selectedBarangayOutbound
    );
  });

  it('supports v2 edgeCapacity parsing and v1 backward-compatible capacity fallback', () => {
    const v2 = createSyntheticMobilityFixture(2, [500, 750, 900, 1100, 1300]);
    const ds2 = parseMobilityDataset(v2.buffer, v2.meta);
    expect(Array.from(ds2.edgeCapacity)).toEqual([500, 750, 900, 1100, 1300]);

    const v1 = createSyntheticMobilityFixture(1);
    const ds1 = parseMobilityDataset(v1.buffer, v1.meta);
    expect(Array.from(ds1.edgeCapacity)).toEqual([1200, 1200, 1200, 1200, 1200]);
  });

  it('consolidates Jeepney passengers (15-20), enforces BPR carriageway congestion, and keeps pedestrians separate', () => {
    // Low capacity (120 PCU/hr) so heavy rush demand builds measurable BPR delay on the 5 synthetic links
    const { buffer, meta } = createSyntheticMobilityFixture(2, [
      120, 120, 120, 120, 120,
    ]);
    const ds = parseMobilityDataset(buffer, meta);
    const sim = new MobilitySimulation(ds, 999);

    const congStats = sim.step(
      0.5,
      10,
      7.5,
      defaultParams({
        targetAgents: 2500,
        congestionEnabled: true,
        congestionLoadScale: 1.5,
      })
    );
    expect(congStats.totalTravellers).toBeGreaterThan(congStats.activeAgents);
    expect(congStats.travelTimeIndex).toBeGreaterThan(1.05);
    expect(congStats.congestedEdgeCount).toBeGreaterThan(0);

    const ribbons = sim.getCongestedEdges(true, 1.5, 0.55);
    expect(ribbons.length).toBeGreaterThan(0);
    expect(ribbons[0].path.length).toBeGreaterThanOrEqual(2);

    // Inspect agents across modes: verify PUV occupancy 15..20, walk channel='sidewalk' & free-flow speed
    let sawPuv = false;
    let sawWalk = false;
    let sawMotorizedSlowed = false;
    for (let i = 0; i < congStats.activeAgents; i += 1) {
      const info = sim.getAgentInfo(i, true, 1.5, true);
      if (!info) continue;
      if (info.mode === 'puv') {
        sawPuv = true;
        expect(info.passengers).toBeGreaterThanOrEqual(15);
        expect(info.passengers).toBeLessThanOrEqual(20);
        expect(info.pcu).toBeCloseTo(2.0, 2);
        expect(info.channel).toBe('carriageway');
      } else if (info.mode === 'walk') {
        sawWalk = true;
        expect(info.passengers).toBe(1);
        expect(info.pcu).toBe(0);
        expect(info.channel).toBe('sidewalk');
        expect(info.currentLinkVc).toBe(0);
        expect(info.speedKmh).toBeCloseTo(info.freeFlowSpeedKmh, 3);
      }
      if (info.mode !== 'walk' && info.speedKmh < info.freeFlowSpeedKmh * 0.95) {
        sawMotorizedSlowed = true;
      }
    }
    expect(sawPuv).toBe(true);
    expect(sawWalk).toBe(true);
    expect(sawMotorizedSlowed).toBe(true);

    // Color by speed keeps walk distinct & computes colors without errors
    sim.refreshVisuals(
      defaultParams({
        targetAgents: 2500,
        congestionEnabled: true,
        colorMode: 'speed',
      })
    );

    // Turning congestion off drops TTI to 1.0 and clears ribbons
    const freeStats = sim.step(
      0.5,
      10,
      7.5,
      defaultParams({
        targetAgents: 2500,
        congestionEnabled: false,
      })
    );
    expect(freeStats.travelTimeIndex).toBeCloseTo(1.0, 4);
    expect(freeStats.congestedEdgeCount).toBe(0);
    expect(sim.getCongestedEdges(true, 1.5)).toEqual([]);
  });

  it('defines mobilityLayer metadata and legend for all 5 modes', () => {
    expect(mobilityLayer.id).toBe('mobility');
    expect(mobilityLayer.category).toBe('mobility');
    expect(mobilityLayer.engine).toBe('deck');
    expect(mobilityLayer.defaultVisible).toBe(true);
    expect(mobilityLayer.legend?.length).toBe(5);
    expect(
      mobilityLayer.buildDeckLayer?.({
        visible: true,
        opacity: 0.95,
        theme: 'dark',
        buildingColorMode: 'class',
        sunHour: 12,
        terrainEnabled: true,
        terrainExaggeration: 1,
        selectedFeature: null,
      })
    ).toBeNull();
  });
});
