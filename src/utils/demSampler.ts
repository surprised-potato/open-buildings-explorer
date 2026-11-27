import type { DemManifest } from '../layers/types';
import { placeFile } from './place';

export interface DemGridConfig {
  width: number;
  height: number;
  bbox: [number, number, number, number]; // [west, south, east, north]
  scale: number;
  nodata: number;
  data: Int16Array;
}

/**
 * Offline bilinear elevation grid sampler backed by a compact Int16 decimeter raster.
 */
export class DemGridSampler {
  readonly width: number;
  readonly height: number;
  readonly bbox: [number, number, number, number];
  readonly scale: number;
  readonly nodata: number;
  readonly data: Int16Array;

  constructor(config: DemGridConfig) {
    this.width = config.width;
    this.height = config.height;
    this.bbox = config.bbox;
    this.scale = config.scale;
    this.nodata = config.nodata;
    this.data = config.data;
  }

  /**
   * Sample elevation in meters ASL at (lon, lat) using bilinear interpolation.
   * Returns null when outside the DEM bounding box or over nodata pixels.
   */
  sampleElevation(lon: number, lat: number): number | null {
    const [west, south, east, north] = this.bbox;
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      lon < west ||
      lon > east ||
      lat < south ||
      lat > north
    ) {
      return null;
    }

    const u = (lon - west) / (east - west);
    const v = (north - lat) / (north - south);

    const fx = Math.max(0, Math.min(this.width - 1, u * (this.width - 1)));
    const fy = Math.max(0, Math.min(this.height - 1, v * (this.height - 1)));

    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(this.width - 1, x0 + 1);
    const y1 = Math.min(this.height - 1, y0 + 1);

    const dx = fx - x0;
    const dy = fy - y0;

    const corners: Array<{ raw: number; weight: number }> = [
      { raw: this.data[y0 * this.width + x0], weight: (1 - dx) * (1 - dy) },
      { raw: this.data[y0 * this.width + x1], weight: dx * (1 - dy) },
      { raw: this.data[y1 * this.width + x0], weight: (1 - dx) * dy },
      { raw: this.data[y1 * this.width + x1], weight: dx * dy },
    ];

    let weightedSum = 0;
    let totalWeight = 0;
    let fallbackSum = 0;
    let fallbackCount = 0;

    for (const c of corners) {
      if (c.raw === this.nodata) continue;
      const meters = c.raw * this.scale;
      fallbackSum += meters;
      fallbackCount += 1;
      if (c.weight > 0) {
        weightedSum += meters * c.weight;
        totalWeight += c.weight;
      }
    }

    if (fallbackCount === 0) return null;
    if (totalWeight > 0) return weightedSum / totalWeight;
    return fallbackSum / fallbackCount;
  }
}

export function formatElevation(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return '—';
  const clamped = Math.abs(meters) < 0.05 ? 0 : meters;
  return `${clamped.toFixed(1)} m ASL`;
}

export async function loadDemGrid(
  baseUrl: string
): Promise<{ manifest: DemManifest; sampler: DemGridSampler } | null> {
  try {
    const manifestRes = await fetch(
      `${baseUrl}${placeFile('dem/dem_manifest.json')}`
    );
    if (!manifestRes.ok) return null;
    const manifest = (await manifestRes.json()) as DemManifest;

    const gridRes = await fetch(`${baseUrl}${manifest.grid.file}`);
    if (!gridRes.ok) return null;
    const buffer = await gridRes.arrayBuffer();

    const expectedCount = manifest.grid.width * manifest.grid.height;
    if (buffer.byteLength < expectedCount * 2) return null;

    const view = new DataView(buffer);
    const data = new Int16Array(expectedCount);
    for (let i = 0; i < expectedCount; i += 1) {
      data[i] = view.getInt16(i * 2, true);
    }

    const sampler = new DemGridSampler({
      width: manifest.grid.width,
      height: manifest.grid.height,
      bbox: manifest.grid.bbox,
      scale: manifest.grid.scale,
      nodata: manifest.grid.nodata,
      data,
    });

    return { manifest, sampler };
  } catch {
    return null;
  }
}
