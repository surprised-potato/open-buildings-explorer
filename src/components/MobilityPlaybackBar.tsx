import { Pause, Play, Sun } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTwinStore } from '../layers/registry';
import type { MobilityPhaseLabel } from '../utils/mobilityTypes';

const SPEED_OPTIONS = [1, 10, 30, 60] as const;

const PHASE_BADGE_STYLES: Record<
  MobilityPhaseLabel,
  { background: string; color: string }
> = {
  'AM Rush': {
    background: 'var(--warning-soft)',
    color: 'var(--warning)',
  },
  Midday: {
    background: 'var(--info-soft)',
    color: 'var(--info)',
  },
  'PM Rush': {
    background: 'var(--danger-soft)',
    color: 'var(--danger)',
  },
  Night: {
    background: 'var(--bg-input)',
    color: 'var(--text-secondary)',
  },
};

function formatClock24h(hours: number): string {
  const normalized = ((hours % 24) + 24) % 24;
  const totalMins = Math.round(normalized * 60) % (24 * 60);
  const hh = String(Math.floor(totalMins / 60)).padStart(2, '0');
  const mm = String(totalMins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function MobilityPlaybackBar() {
  const {
    layerState,
    mobilityPlaying,
    setMobilityPlaying,
    mobilityTimeHours,
    setMobilityTimeHours,
    mobilitySpeed,
    setMobilitySpeed,
    mobilitySyncSun,
    setMobilitySyncSun,
    mobilityCongestionEnabled,
    mobilityStats,
  } = useTwinStore();

  const sliderRef = useRef<HTMLInputElement | null>(null);
  const clampedHours = Math.min(23.95, Math.max(0, mobilityTimeHours));

  useLayoutEffect(() => {
    const el = sliderRef.current;
    if (!el) return;
    el.style.setProperty('--control-value', String(clampedHours));
    el.style.setProperty('--attr-min', '0');
    el.style.setProperty('--attr-max', '23.95');
  }, [clampedHours]);

  if (!layerState.mobility?.visible) {
    return null;
  }

  const phaseStyle = PHASE_BADGE_STYLES[mobilityStats.phaseLabel];

  return (
    <section
      className="hud-mobility-bar glass-panel"
      aria-label="Mobility simulation playback"
    >
      <button
        type="button"
        className="btn btn-icon btn-primary"
        onClick={() => setMobilityPlaying(!mobilityPlaying)}
        aria-label={
          mobilityPlaying
            ? 'Pause mobility simulation'
            : 'Play mobility simulation'
        }
        title={mobilityPlaying ? 'Pause' : 'Play'}
      >
        {mobilityPlaying ? <Pause size={14} /> : <Play size={14} />}
      </button>

      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--text-primary)',
            minWidth: 44,
          }}
        >
          {formatClock24h(mobilityTimeHours)}
        </span>
        <span
          className="badge"
          style={{
            background: phaseStyle.background,
            color: phaseStyle.color,
            textTransform: 'none',
            letterSpacing: '0.01em',
          }}
        >
          {mobilityStats.phaseLabel}
        </span>
      </div>

      <div style={{ flex: '1 1 130px', minWidth: 100, display: 'flex', alignItems: 'center' }}>
        <input
          ref={sliderRef}
          type="range"
          min={0}
          max={23.95}
          step={0.05}
          value={clampedHours}
          aria-label="Time of day"
          onChange={(e) => {
            const next = Number(e.target.value);
            e.currentTarget.style.setProperty('--control-value', String(next));
            e.currentTarget.style.setProperty('--attr-min', '0');
            e.currentTarget.style.setProperty('--attr-max', '23.95');
            setMobilityTimeHours(next);
          }}
        />
      </div>

      <div
        className="segmented-control"
        role="group"
        aria-label="Simulation speed"
      >
        {SPEED_OPTIONS.map((speed) => (
          <button
            key={speed}
            type="button"
            className={`segmented-btn ${mobilitySpeed === speed ? 'active' : ''}`}
            aria-pressed={mobilitySpeed === speed}
            onClick={() => setMobilitySpeed(speed)}
            style={{ padding: '3px 7px', fontSize: 11 }}
          >
            {speed}x
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`btn ${mobilitySyncSun ? 'active' : ''}`}
        aria-pressed={mobilitySyncSun}
        onClick={() => setMobilitySyncSun(!mobilitySyncSun)}
        title="Sync 3D sun lighting with simulation clock"
        style={{ height: 28, padding: '0 8px', fontSize: 11.5 }}
      >
        <Sun
          size={13}
          style={{ color: mobilitySyncSun ? 'var(--warning)' : undefined }}
        />
        <span>Sync Sun</span>
      </button>

      <span
        className="pill"
        style={{
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}
        title={
          mobilityStats.loaded
            ? `${mobilityStats.activeAgents.toLocaleString()} road/sidewalk units moving ${mobilityStats.totalTravellers.toLocaleString()} people`
            : undefined
        }
      >
        {mobilityStats.loaded
          ? `${(mobilityStats.totalTravellers || mobilityStats.activeAgents).toLocaleString()} pax`
          : 'Loading swarm…'}
      </span>

      {mobilityStats.loaded && mobilityCongestionEnabled && (
        <span
          className="badge"
          style={{
            fontFamily: 'var(--font-mono)',
            background:
              mobilityStats.travelTimeIndex >= 1.35
                ? 'var(--danger-soft)'
                : mobilityStats.travelTimeIndex >= 1.1
                  ? 'var(--warning-soft)'
                  : 'var(--success-soft)',
            color:
              mobilityStats.travelTimeIndex >= 1.35
                ? 'var(--danger)'
                : mobilityStats.travelTimeIndex >= 1.1
                  ? 'var(--warning)'
                  : 'var(--success)',
          }}
          title="Travel Time Index (congested vs. free-flow motorized travel time)"
        >
          TTI {mobilityStats.travelTimeIndex.toFixed(2)}×
        </span>
      )}
    </section>
  );
}
