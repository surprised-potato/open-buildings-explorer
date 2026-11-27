import { Mountain, Ruler, Shapes, Trash2, Undo2, X } from 'lucide-react';
import type maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BUILDINGS_LAYER_ID } from '../layers/builtins/buildingsLayer';
import { useTwinStore } from '../layers/registry';
import {
  buildElevationProfile,
  type BuildingHeightSample,
} from '../utils/elevationProfile';
import {
  computePathLengthMeters,
  computePolygonAreaSqMeters,
  formatArea,
  formatDistance,
} from '../utils/geometry';

export type MeasureMode = 'off' | 'distance' | 'area';

interface MeasureControlProps {
  mode: MeasureMode;
  points: [number, number][];
  map?: maplibregl.Map | null;
  onChangeMode: (mode: MeasureMode) => void;
  onUndo: () => void;
  onClear: () => void;
  onClose: () => void;
  onHoverProfileCoord?: (coord: [number, number] | null) => void;
}

const CHART_W = 460;
const CHART_H = 114;
const PAD_L = 38;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 20;

export function MeasureControl({
  mode,
  points,
  map = null,
  onChangeMode,
  onUndo,
  onClear,
  onClose,
  onHoverProfileCoord,
}: MeasureControlProps) {
  const { sampleElevation } = useTwinStore();
  const [showProfile, setShowProfile] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    setHoverIdx(null);
    onHoverProfileCoord?.(null);
  }, [points, mode, onHoverProfileCoord]);

  const sampleBuildingAt = useCallback(
    (lon: number, lat: number): BuildingHeightSample | null => {
      if (!map) return null;
      try {
        if (!map.getLayer(BUILDINGS_LAYER_ID)) return null;
        const canvas = map.getCanvas();
        const pt = map.project([lon, lat]);
        if (
          !Number.isFinite(pt.x) ||
          !Number.isFinite(pt.y) ||
          pt.x < 0 ||
          pt.y < 0 ||
          pt.x > canvas.clientWidth ||
          pt.y > canvas.clientHeight
        ) {
          return null;
        }
        const hits = map.queryRenderedFeatures(pt, {
          layers: [BUILDINGS_LAYER_ID],
        });
        if (!hits || hits.length === 0) return null;

        let tallest: BuildingHeightSample | null = null;
        for (const hit of hits) {
          const props = (hit.properties ?? {}) as Record<string, unknown>;
          const rawH =
            typeof props.effective_height === 'number'
              ? props.effective_height
              : typeof props.height === 'number'
                ? props.height
                : 0;
          if (rawH > 0 && (!tallest || rawH > tallest.effectiveHeight)) {
            tallest = {
              id:
                (typeof props.id === 'string' || typeof props.id === 'number'
                  ? props.id
                  : undefined) ?? hit.id,
              name: typeof props.name === 'string' ? props.name : null,
              bclass: typeof props.bclass === 'string' ? props.bclass : null,
              effectiveHeight: rawH,
            };
          }
        }
        return tallest;
      } catch {
        return null;
      }
    },
    [map]
  );

  const profile = useMemo(() => {
    if (mode !== 'distance' || points.length < 2) return null;
    return buildElevationProfile(points, sampleElevation, sampleBuildingAt, 80);
  }, [mode, points, sampleElevation, sampleBuildingAt]);

  if (mode === 'off') return null;

  const metricReadout =
    mode === 'distance'
      ? formatDistance(computePathLengthMeters(points))
      : formatArea(computePolygonAreaSqMeters(points));

  const sampledElevs = points
    .map(([lon, lat]) => sampleElevation(lon, lat))
    .filter((v): v is number => v !== null);

  let elevSummary: string | null = null;
  if (sampledElevs.length >= 2) {
    const minE = Math.min(...sampledElevs);
    const maxE = Math.max(...sampledElevs);
    const delta = sampledElevs[sampledElevs.length - 1] - sampledElevs[0];
    const sign = delta >= 0 ? '+' : '';
    elevSummary =
      mode === 'distance'
        ? `Δ ${sign}${delta.toFixed(1)} m (${minE.toFixed(0)}–${maxE.toFixed(0)} m ASL)`
        : `Relief ${(maxE - minE).toFixed(1)} m (${minE.toFixed(0)}–${maxE.toFixed(0)} m ASL)`;
  } else if (sampledElevs.length === 1) {
    elevSummary = `${sampledElevs[0].toFixed(1)} m ASL`;
  }

  const hint =
    points.length === 0
      ? 'Click map to place points'
      : mode === 'distance' && points.length === 1
        ? 'Click next point'
        : mode === 'area' && points.length < 3
          ? `Place ${3 - points.length} more point${3 - points.length === 1 ? '' : 's'}`
          : `${points.length} pts`;

  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;

  const chartGeometry = (() => {
    if (!profile || profile.samples.length < 2 || profile.minGroundM === null) {
      return null;
    }
    const yMin = Math.max(0, Math.floor(profile.minGroundM - 1));
    const rawTop = profile.maxRoofM ?? profile.maxGroundM ?? yMin + 10;
    const yMax = Math.max(yMin + 5, Math.ceil(rawTop + 2));
    const ySpan = yMax - yMin;
    const totalDist = Math.max(1, profile.totalDistanceM);

    const toX = (d: number) => PAD_L + (d / totalDist) * innerW;
    const toY = (elev: number) =>
      PAD_T + innerH - ((elev - yMin) / ySpan) * innerH;

    const linePts: string[] = [];
    const areaPts: string[] = [];
    const bars: Array<{
      x: number;
      y: number;
      w: number;
      h: number;
      idx: number;
    }> = [];

    const barW = Math.max(2.5, innerW / profile.samples.length);

    profile.samples.forEach((s, idx) => {
      if (s.groundM === null) return;
      const x = toX(s.distanceM);
      const yGround = toY(s.groundM);
      linePts.push(`${x.toFixed(1)},${yGround.toFixed(1)}`);
      areaPts.push(`${x.toFixed(1)},${yGround.toFixed(1)}`);

      if (s.buildingHeightM > 0 && s.roofM !== null) {
        const yRoof = toY(s.roofM);
        const h = Math.max(1.5, yGround - yRoof);
        bars.push({
          x: x - barW / 2,
          y: yRoof,
          w: barW,
          h,
          idx,
        });
      }
    });

    if (areaPts.length >= 2) {
      const firstX = toX(profile.samples[0].distanceM).toFixed(1);
      const lastX = toX(
        profile.samples[profile.samples.length - 1].distanceM
      ).toFixed(1);
      const baseY = (PAD_T + innerH).toFixed(1);
      areaPts.push(`${lastX},${baseY}`, `${firstX},${baseY}`);
    }

    return { yMin, yMax, linePts, areaPts, bars, toX, toY };
  })();

  const hoveredSample =
    profile && hoverIdx !== null ? profile.samples[hoverIdx] ?? null : null;

  return (
    <div className="hud-measure-wrap">
      {mode === 'distance' && showProfile && profile && chartGeometry && (
        <section
          className="profile-chart-wrap glass-panel"
          aria-label="Terrain and building elevation profile"
        >
          <div className="profile-header">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, fontSize: 11.5 }}>
              <Mountain size={13} style={{ color: 'var(--accent)' }} />
              Elevation Cross-Section
            </span>
            <div className="profile-stats">
              <span>+{profile.totalGainM} m</span>
              <span>-{profile.totalLossM} m</span>
              <span>Max {profile.maxSlopePct}%</span>
              <span>{profile.buildingsSlicedCount} bldgs</span>
            </div>
          </div>

          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            className="profile-svg"
            role="img"
            aria-label="Elevation profile chart"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * CHART_W;
              const t = Math.max(
                0,
                Math.min(1, (relX - PAD_L) / innerW)
              );
              const idx = Math.min(
                profile.samples.length - 1,
                Math.max(0, Math.round(t * (profile.samples.length - 1)))
              );
              setHoverIdx(idx);
              const s = profile.samples[idx];
              if (s) onHoverProfileCoord?.([s.lon, s.lat]);
            }}
            onMouseLeave={() => {
              setHoverIdx(null);
              onHoverProfileCoord?.(null);
            }}
          >
            <line
              x1={PAD_L}
              y1={PAD_T}
              x2={CHART_W - PAD_R}
              y2={PAD_T}
              stroke="rgba(148,163,184,0.22)"
              strokeDasharray="3 3"
            />
            <line
              x1={PAD_L}
              y1={PAD_T + innerH}
              x2={CHART_W - PAD_R}
              y2={PAD_T + innerH}
              stroke="rgba(148,163,184,0.35)"
            />

            <text
              x={PAD_L - 4}
              y={PAD_T + 8}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize="9"
              fontFamily="var(--font-mono)"
            >
              {chartGeometry.yMax}m
            </text>
            <text
              x={PAD_L - 4}
              y={PAD_T + innerH}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize="9"
              fontFamily="var(--font-mono)"
            >
              {chartGeometry.yMin}m
            </text>
            <text
              x={PAD_L}
              y={CHART_H - 5}
              textAnchor="start"
              fill="var(--text-muted)"
              fontSize="9"
              fontFamily="var(--font-mono)"
            >
              0 m
            </text>
            <text
              x={CHART_W - PAD_R}
              y={CHART_H - 5}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize="9"
              fontFamily="var(--font-mono)"
            >
              {formatDistance(profile.totalDistanceM)}
            </text>

            {chartGeometry.areaPts.length > 0 && (
              <polygon
                points={chartGeometry.areaPts.join(' ')}
                fill="rgba(56, 189, 248, 0.2)"
              />
            )}

            {chartGeometry.bars.map((bar) => (
              <rect
                key={bar.idx}
                x={bar.x}
                y={bar.y}
                width={bar.w}
                height={bar.h}
                fill="rgba(245, 158, 11, 0.72)"
                stroke="#fbbf24"
                strokeWidth="0.6"
              />
            ))}

            {chartGeometry.linePts.length > 0 && (
              <polyline
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2"
                points={chartGeometry.linePts.join(' ')}
              />
            )}

            {hoveredSample && hoveredSample.groundM !== null && (
              <>
                <line
                  x1={chartGeometry.toX(hoveredSample.distanceM)}
                  y1={PAD_T}
                  x2={chartGeometry.toX(hoveredSample.distanceM)}
                  y2={PAD_T + innerH}
                  stroke="#fde047"
                  strokeWidth="1.2"
                  strokeDasharray="2 2"
                />
                <circle
                  cx={chartGeometry.toX(hoveredSample.distanceM)}
                  cy={chartGeometry.toY(hoveredSample.groundM)}
                  r="3.5"
                  fill="#fde047"
                  stroke="#0f172a"
                  strokeWidth="1"
                />
              </>
            )}
          </svg>

          {hoveredSample && (
            <div className="profile-hover-bar">
              <span>{formatDistance(hoveredSample.distanceM)}</span>
              <span>
                Ground:{' '}
                {hoveredSample.groundM !== null
                  ? `${hoveredSample.groundM.toFixed(1)} m`
                  : '—'}
              </span>
              {hoveredSample.buildingHeightM > 0 && (
                <span style={{ color: 'var(--warning)' }}>
                  {hoveredSample.buildingName ||
                    hoveredSample.buildingClass ||
                    'Building'}{' '}
                  +{hoveredSample.buildingHeightM.toFixed(1)} m (Roof{' '}
                  {hoveredSample.roofM?.toFixed(1)} m)
                </span>
              )}
            </div>
          )}
        </section>
      )}

      <section
        className="hud-measure glass-panel"
        aria-label="Measurement tool"
      >
        <div className="segmented-control" role="group" aria-label="Measure mode">
          <button
            type="button"
            className={`segmented-btn ${mode === 'distance' ? 'active' : ''}`}
            onClick={() => onChangeMode('distance')}
            aria-pressed={mode === 'distance'}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Ruler size={13} />
              Distance
            </span>
          </button>
          <button
            type="button"
            className={`segmented-btn ${mode === 'area' ? 'active' : ''}`}
            onClick={() => onChangeMode('area')}
            aria-pressed={mode === 'area'}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Shapes size={13} />
              Area
            </span>
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            paddingInline: 6,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              fontSize: 13,
              color: 'var(--text-primary)',
            }}
          >
            {metricReadout}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {hint}
          </span>
          {elevSummary && (
            <span className="pill" style={{ fontFamily: 'var(--font-mono)' }}>
              {elevSummary}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {mode === 'distance' && points.length >= 2 && (
            <button
              type="button"
              className={`btn ${showProfile ? 'active' : ''}`}
              style={{ height: 28, fontSize: 11, paddingInline: 8 }}
              onClick={() => setShowProfile((prev) => !prev)}
              aria-pressed={showProfile}
              title="Toggle elevation cross-section profile"
            >
              <Mountain size={13} />
              Profile
            </button>
          )}
          <button
            type="button"
            className="btn btn-icon"
            onClick={onUndo}
            disabled={points.length === 0}
            title="Undo last point"
            aria-label="Undo last point"
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={onClear}
            disabled={points.length === 0}
            title="Clear points"
            aria-label="Clear points"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={onClose}
            title="Close measure tool"
            aria-label="Close measure tool"
          >
            <X size={14} />
          </button>
        </div>
      </section>
    </div>
  );
}
