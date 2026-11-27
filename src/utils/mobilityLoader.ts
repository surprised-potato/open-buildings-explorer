import {
  MOBILITY_BUILDINGS_MAGIC,
  type MobilityBuildings,
  type MobilityDataset,
  type MobilityZonesMetadata,
} from './mobilityTypes';

export const MOBILITY_BINARY_MAGIC = 0x424d4f42; // 'BMOB'
export const MOBILITY_BINARY_VERSION = 2;

const IS_LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setUint16(0, 1, true);
  return new Uint16Array(buf)[0] === 1;
})();

function align4(byteLength: number): number {
  return (byteLength + 3) & ~3;
}

function readUint32Slice(
  buffer: ArrayBuffer,
  view: DataView,
  byteOffset: number,
  length: number
): Uint32Array {
  if (IS_LITTLE_ENDIAN && byteOffset % 4 === 0) {
    return new Uint32Array(buffer, byteOffset, length);
  }
  const out = new Uint32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = view.getUint32(byteOffset + i * 4, true);
  }
  return out;
}

function readFloat32Slice(
  buffer: ArrayBuffer,
  view: DataView,
  byteOffset: number,
  length: number
): Float32Array {
  if (IS_LITTLE_ENDIAN && byteOffset % 4 === 0) {
    return new Float32Array(buffer, byteOffset, length);
  }
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = view.getFloat32(byteOffset + i * 4, true);
  }
  return out;
}

function readUint16Slice(
  buffer: ArrayBuffer,
  view: DataView,
  byteOffset: number,
  length: number
): Uint16Array {
  if (IS_LITTLE_ENDIAN && byteOffset % 2 === 0) {
    return new Uint16Array(buffer, byteOffset, length);
  }
  const out = new Uint16Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = view.getUint16(byteOffset + i * 2, true);
  }
  return out;
}

/**
 * Precompute cumulative normalized arc-length fraction [0..1] for every
 * polyline vertex in `geomCoords` so curved edge interpolation needs zero allocations.
 */
export function computePolylineCumFractions(
  nEdges: number,
  geomOffs: Uint32Array,
  geomCoords: Float32Array
): Float32Array {
  const nPts = geomOffs.length > nEdges ? geomOffs[nEdges] : geomCoords.length >>> 1;
  const ptCumFrac = new Float32Array(nPts);

  for (let e = 0; e < nEdges; e += 1) {
    const start = geomOffs[e];
    const end = geomOffs[e + 1];
    const count = end - start;
    if (count <= 0 || end > nPts) continue;

    ptCumFrac[start] = 0;
    if (count === 1) continue;

    const lat0 = geomCoords[start * 2 + 1];
    const cosLat = Math.cos((lat0 * Math.PI) / 180);
    let totalDist = 0;

    for (let i = start + 1; i < end; i += 1) {
      const dx = (geomCoords[i * 2] - geomCoords[(i - 1) * 2]) * cosLat;
      const dy = geomCoords[i * 2 + 1] - geomCoords[(i - 1) * 2 + 1];
      totalDist += Math.hypot(dx, dy);
      ptCumFrac[i] = totalDist;
    }

    if (totalDist > 1e-12) {
      const invTotal = 1 / totalDist;
      for (let i = start + 1; i < end - 1; i += 1) {
        ptCumFrac[i] *= invTotal;
      }
    } else {
      const denom = count - 1;
      for (let i = start + 1; i < end - 1; i += 1) {
        ptCumFrac[i] = (i - start) / denom;
      }
    }
    ptCumFrac[end - 1] = 1;
  }

  return ptCumFrac;
}

/**
 * Parse a binary `mobility_network.bin` ArrayBuffer alongside `mobility_zones.json`.
 */
function readUint8Slice(buffer: ArrayBuffer, byteOffset: number, length: number): Uint8Array {
  return new Uint8Array(buffer, byteOffset, length);
}

/**
 * Parse `mobility_buildings.bin` (+ its sidecar JSON with class names and named buildings).
 * Throws on a malformed or mismatched file; callers treat the table as optional.
 */
/** Format a building's 16 stored UUID bytes as the GERS id string used by the map source. */
export function buildingGersId(b: MobilityBuildings, index: number): string | null {
  const ids = b.gersIds;
  if (!ids) return null;
  const o = index * 16;
  let allZero = true;
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    const v = ids[o + i];
    if (v !== 0) allZero = false;
    out += (v < 16 ? '0' : '') + v.toString(16);
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return allZero ? null : out;
}

export function parseMobilityBuildings(
  buffer: ArrayBuffer,
  sidecar: { classes: string[]; named?: Record<string, [string, string]> },
  nZones: number,
  nNodes: number
): MobilityBuildings {
  if (buffer.byteLength < 32) throw new Error('Invalid mobility buildings binary: too short');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MOBILITY_BUILDINGS_MAGIC) {
    throw new Error('Invalid mobility buildings magic');
  }
  const count = view.getUint32(8, true);
  const hZones = view.getUint32(12, true);
  const hNodes = view.getUint32(16, true);
  if (hZones !== nZones || hNodes !== nNodes) {
    throw new Error(
      `Mobility buildings mismatch: zones ${hZones}/${nZones}, nodes ${hNodes}/${nNodes}`
    );
  }
  let off = 32;
  const zoneOffs = new Uint32Array(nZones + 1);
  for (let i = 0; i <= nZones; i += 1) zoneOffs[i] = view.getUint32(off + i * 4, true);
  off += (nZones + 1) * 4;
  const lon = readFloat32Slice(buffer, view, off, count);
  off += count * 4;
  const lat = readFloat32Slice(buffer, view, off, count);
  off += count * 4;
  const areaM2 = readFloat32Slice(buffer, view, off, count);
  off += count * 4;
  const node = readUint16Slice(buffer, view, off, count);
  off += align4(count * 2);
  const cls = readUint8Slice(buffer, off, count);
  off += align4(count);
  const weights = [0, 1, 2, 3].map((k) => {
    const arr = readUint16Slice(buffer, view, off + k * align4(count * 2), count);
    return arr;
  }) as MobilityBuildings['weights'];
  off += 4 * align4(count * 2);
  const toHubNextEdge = readUint16Slice(buffer, view, off, 3 * nZones * nNodes);
  off += align4(3 * nZones * nNodes * 2);
  const hasIds = view.getUint32(24, true) === 1 && off + 16 * count <= buffer.byteLength;
  const gersIds = hasIds ? readUint8Slice(buffer, off, 16 * count) : undefined;
  return {
    gersIds,
    count,
    zoneOffs,
    lon,
    lat,
    areaM2,
    node,
    cls,
    classes: sidecar.classes,
    weights,
    toHubNextEdge,
    named: sidecar.named ?? {},
  };
}

export function parseMobilityDataset(
  buffer: ArrayBuffer,
  meta: MobilityZonesMetadata
): MobilityDataset {
  if (buffer.byteLength < 32) {
    throw new Error(
      `Invalid mobility binary: expected at least 32 header bytes, got ${buffer.byteLength}`
    );
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== MOBILITY_BINARY_MAGIC) {
    throw new Error(
      `Invalid mobility binary magic: expected 0x${MOBILITY_BINARY_MAGIC.toString(16)}, got 0x${magic.toString(16)}`
    );
  }

  const version = view.getUint32(4, true);
  if (version !== 1 && version !== MOBILITY_BINARY_VERSION) {
    throw new Error(
      `Unsupported mobility binary version: expected 1 or ${MOBILITY_BINARY_VERSION}, got ${version}`
    );
  }

  const nNodes = view.getUint32(8, true);
  const nEdges = view.getUint32(12, true);
  const nPts = view.getUint32(16, true);
  const nZones = view.getUint32(20, true);
  const nProfiles = view.getUint32(24, true);

  if (nProfiles < 1) {
    throw new Error(`Invalid mobility binary profile count: ${nProfiles}`);
  }
  if (meta.zones.length !== nZones) {
    throw new Error(
      `Mobility zone count mismatch: binary has ${nZones}, metadata has ${meta.zones.length}`
    );
  }

  const hasCapacitySection = version >= 2;
  const expectedByteLength =
    32 +
    nNodes * 4 * 3 +
    align4(nEdges * 2) * 2 +
    nEdges * 4 +
    (hasCapacitySection ? nEdges * 4 : 0) +
    5 * nEdges * 4 +
    (nEdges + 1) * 4 +
    2 * nPts * 4 +
    align4(nProfiles * nZones * nNodes * 2);

  if (buffer.byteLength < expectedByteLength) {
    throw new Error(
      `Truncated mobility binary: expected >= ${expectedByteLength} bytes, got ${buffer.byteLength}`
    );
  }

  let offset = 32;

  const nodeLon = readFloat32Slice(buffer, view, offset, nNodes);
  offset += nNodes * 4;

  const nodeLat = readFloat32Slice(buffer, view, offset, nNodes);
  offset += nNodes * 4;

  const nodeElev = readFloat32Slice(buffer, view, offset, nNodes);
  offset += nNodes * 4;

  const edgeSrc = readUint16Slice(buffer, view, offset, nEdges);
  offset += align4(nEdges * 2);

  const edgeDst = readUint16Slice(buffer, view, offset, nEdges);
  offset += align4(nEdges * 2);

  const edgeLenKm = readFloat32Slice(buffer, view, offset, nEdges);
  offset += nEdges * 4;

  const edgeCapacity = hasCapacitySection
    ? readFloat32Slice(buffer, view, offset, nEdges)
    : new Float32Array(nEdges).fill(1200);
  if (hasCapacitySection) {
    offset += nEdges * 4;
  }

  const edgeT0Sec = readFloat32Slice(buffer, view, offset, 5 * nEdges);
  offset += 5 * nEdges * 4;

  const geomOffs = readUint32Slice(buffer, view, offset, nEdges + 1);
  offset += (nEdges + 1) * 4;

  const geomCoords = readFloat32Slice(buffer, view, offset, 2 * nPts);
  offset += 2 * nPts * 4;

  const fromHubPrevEdge = readUint16Slice(
    buffer,
    view,
    offset,
    nProfiles * nZones * nNodes
  );

  const ptCumFrac = computePolylineCumFractions(nEdges, geomOffs, geomCoords);

  return {
    meta,
    nNodes,
    nEdges,
    nPts,
    nZones,
    nProfiles,
    nodeLon,
    nodeLat,
    nodeElev,
    edgeSrc,
    edgeDst,
    edgeLenKm,
    edgeCapacity,
    edgeT0Sec,
    geomOffs,
    geomCoords,
    fromHubPrevEdge,
    ptCumFrac,
  };
}

/**
 * Fetch and parse both `mobility_zones.json` and `mobility_network.bin`.
 */
export async function loadMobilityDataset(
  baseUrl = '/',
  signal?: AbortSignal
): Promise<MobilityDataset> {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const [zonesRes, binRes] = await Promise.all([
    fetch(`${normalizedBase}data/bacolod/mobility_zones.json`, { signal }),
    fetch(`${normalizedBase}data/bacolod/mobility_network.bin`, { signal }),
  ]);

  if (!zonesRes.ok) {
    throw new Error(
      `Failed to fetch mobility_zones.json (${zonesRes.status})`
    );
  }
  if (!binRes.ok) {
    throw new Error(
      `Failed to fetch mobility_network.bin (${binRes.status})`
    );
  }

  const [meta, buffer] = await Promise.all([
    zonesRes.json() as Promise<MobilityZonesMetadata>,
    binRes.arrayBuffer(),
  ]);

  const dataset = parseMobilityDataset(buffer, meta);

  // Building-level origins/destinations are optional: fall back to access nodes if absent.
  try {
    const [bBinRes, bJsonRes] = await Promise.all([
      fetch(`${normalizedBase}data/bacolod/mobility_buildings.bin`, { signal }),
      fetch(`${normalizedBase}data/bacolod/mobility_buildings.json`, { signal }),
    ]);
    if (bBinRes.ok && bJsonRes.ok) {
      const [bBuf, bJson] = await Promise.all([bBinRes.arrayBuffer(), bJsonRes.json()]);
      dataset.buildings = parseMobilityBuildings(bBuf, bJson, dataset.nZones, dataset.nNodes);
    }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    console.warn('Mobility buildings unavailable; using zone access nodes', err);
  }

  return dataset;
}
