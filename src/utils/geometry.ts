const EARTH_RADIUS_METERS = 6_371_008.8;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Compute geodesic distance in meters along a polyline of [lon, lat] coordinates
 * using the Haversine formula.
 */
export function computePathLengthMeters(coords: [number, number][]): number {
  if (coords.length < 2) return 0;

  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const rLat1 = toRadians(lat1);
    const rLat2 = toRadians(lat2);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    total += EARTH_RADIUS_METERS * c;
  }

  return total;
}

/**
 * Compute spherical polygon area in square meters for a ring of [lon, lat] coordinates.
 */
export function computePolygonAreaSqMeters(coords: [number, number][]): number {
  if (coords.length < 3) return 0;

  const ring = coords.slice();
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat) {
    ring.push([firstLon, firstLat]);
  }

  if (ring.length < 4) return 0;

  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    total +=
      toRadians(lon2 - lon1) *
      (2 + Math.sin(toRadians(lat1)) + Math.sin(toRadians(lat2)));
  }

  return Math.abs((total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS) / 2);
}

/**
 * Format a distance in meters into a human-readable metric string.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 10) return `${meters.toFixed(1)} m`;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/**
 * Format an area in square meters into m², hectares (ha), or km².
 */
export function formatArea(sqMeters: number): string {
  if (!Number.isFinite(sqMeters) || sqMeters <= 0) return '0 m²';
  if (sqMeters < 10_000) return `${Math.round(sqMeters)} m²`;
  if (sqMeters < 1_000_000) return `${(sqMeters / 10_000).toFixed(2)} ha`;
  return `${(sqMeters / 1_000_000).toFixed(2)} km²`;
}
