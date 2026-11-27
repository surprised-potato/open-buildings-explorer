import { computePathLengthMeters } from './geometry';

export interface BuildingHeightSample {
  id?: string | number;
  name?: string | null;
  bclass?: string | null;
  effectiveHeight: number;
}

export interface ElevationProfileSample {
  distanceM: number;
  lon: number;
  lat: number;
  groundM: number | null;
  buildingHeightM: number;
  roofM: number | null;
  buildingId?: string | number;
  buildingName?: string | null;
  buildingClass?: string | null;
}

export interface ElevationProfileResult {
  samples: ElevationProfileSample[];
  totalDistanceM: number;
  minGroundM: number | null;
  maxGroundM: number | null;
  maxRoofM: number | null;
  totalGainM: number;
  totalLossM: number;
  maxSlopePct: number;
  buildingsSlicedCount: number;
}

export interface PathStation {
  distanceM: number;
  lon: number;
  lat: number;
}

/**
 * Resample a polyline of [lon, lat] vertices into evenly spaced stations along geodesic distance.
 */
export function samplePathPoints(
  coords: [number, number][],
  sampleCount = 80
): PathStation[] {
  if (coords.length < 2) return [];

  const count = Math.max(2, Math.round(sampleCount));
  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += computePathLengthMeters([coords[i - 1], coords[i]]);
    cumulative.push(total);
  }

  if (total <= 0) {
    return [
      { distanceM: 0, lon: coords[0][0], lat: coords[0][1] },
      {
        distanceM: 0,
        lon: coords[coords.length - 1][0],
        lat: coords[coords.length - 1][1],
      },
    ];
  }

  const stations: PathStation[] = [];
  let segIdx = 0;

  for (let i = 0; i < count; i += 1) {
    const targetDist = (i / (count - 1)) * total;
    while (
      segIdx < cumulative.length - 2 &&
      cumulative[segIdx + 1] < targetDist
    ) {
      segIdx += 1;
    }

    const segStart = cumulative[segIdx];
    const segEnd = cumulative[segIdx + 1];
    const segLen = segEnd - segStart;
    const t =
      segLen > 0
        ? Math.max(0, Math.min(1, (targetDist - segStart) / segLen))
        : 0;

    const [lon1, lat1] = coords[segIdx];
    const [lon2, lat2] = coords[segIdx + 1];
    stations.push({
      distanceM: targetDist,
      lon: lon1 + (lon2 - lon1) * t,
      lat: lat1 + (lat2 - lat1) * t,
    });
  }

  return stations;
}

/**
 * Build a terrain + 3D building elevation cross-section profile along a measured path.
 */
export function buildElevationProfile(
  coords: [number, number][],
  sampleElevation: (lon: number, lat: number) => number | null,
  sampleBuildingAt?: (lon: number, lat: number) => BuildingHeightSample | null,
  sampleCount = 80
): ElevationProfileResult {
  const stations = samplePathPoints(coords, sampleCount);
  if (stations.length === 0) {
    return {
      samples: [],
      totalDistanceM: 0,
      minGroundM: null,
      maxGroundM: null,
      maxRoofM: null,
      totalGainM: 0,
      totalLossM: 0,
      maxSlopePct: 0,
      buildingsSlicedCount: 0,
    };
  }

  const samples: ElevationProfileSample[] = [];
  let minGroundM: number | null = null;
  let maxGroundM: number | null = null;
  let maxRoofM: number | null = null;
  let totalGainM = 0;
  let totalLossM = 0;
  let maxSlopePct = 0;

  const seenBuildings = new Set<string>();
  let prevGround: number | null = null;
  let prevDist = 0;
  let prevWasBuilding = false;
  let anonymousBuildingSegments = 0;

  for (const st of stations) {
    const groundM = sampleElevation(st.lon, st.lat);
    const bldg = sampleBuildingAt ? sampleBuildingAt(st.lon, st.lat) : null;
    const buildingHeightM =
      bldg && Number.isFinite(bldg.effectiveHeight) && bldg.effectiveHeight > 0
        ? bldg.effectiveHeight
        : 0;
    const roofM =
      groundM !== null ? groundM + buildingHeightM : buildingHeightM > 0 ? buildingHeightM : null;

    if (groundM !== null && Number.isFinite(groundM)) {
      if (minGroundM === null || groundM < minGroundM) minGroundM = groundM;
      if (maxGroundM === null || groundM > maxGroundM) maxGroundM = groundM;

      if (prevGround !== null) {
        const delta = groundM - prevGround;
        if (delta > 0) totalGainM += delta;
        else if (delta < 0) totalLossM += -delta;

        const run = st.distanceM - prevDist;
        if (run > 0.5) {
          const slopePct = (Math.abs(delta) / run) * 100;
          if (slopePct > maxSlopePct) maxSlopePct = slopePct;
        }
      }
      prevGround = groundM;
      prevDist = st.distanceM;
    }

    if (roofM !== null && (maxRoofM === null || roofM > maxRoofM)) {
      maxRoofM = roofM;
    }

    if (buildingHeightM > 0) {
      if (bldg?.id !== undefined && bldg.id !== null) {
        seenBuildings.add(String(bldg.id));
      } else if (!prevWasBuilding) {
        anonymousBuildingSegments += 1;
      }
      prevWasBuilding = true;
    } else {
      prevWasBuilding = false;
    }

    samples.push({
      distanceM: st.distanceM,
      lon: st.lon,
      lat: st.lat,
      groundM,
      buildingHeightM,
      roofM,
      buildingId: bldg?.id,
      buildingName: bldg?.name ?? null,
      buildingClass: bldg?.bclass ?? null,
    });
  }

  return {
    samples,
    totalDistanceM: stations[stations.length - 1].distanceM,
    minGroundM,
    maxGroundM,
    maxRoofM,
    totalGainM: Number(totalGainM.toFixed(1)),
    totalLossM: Number(totalLossM.toFixed(1)),
    maxSlopePct: Number(maxSlopePct.toFixed(1)),
    buildingsSlicedCount:
      seenBuildings.size > 0
        ? seenBuildings.size + anonymousBuildingSegments
        : anonymousBuildingSegments,
  };
}
