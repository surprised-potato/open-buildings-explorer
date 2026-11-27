import { Compass, Minus, Plus, RotateCw, SlidersHorizontal, X } from 'lucide-react';
import type maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlaceMeta } from '../utils/place';

/** The place's home camera (place.json homeView). */
export function homeView() {
  return getPlaceMeta().homeView;
}

const PRESETS: { id: string; label: string; pitch: number; bearing?: number }[] = [
  { id: 'top', label: 'Top-down', pitch: 0, bearing: 0 },
  { id: 'oblique', label: 'Oblique', pitch: 58 },
  { id: 'street', label: 'Street', pitch: 80 },
];

interface ViewState {
  zoom: number;
  pitch: number;
  bearing: number;
}

function readView(map: maplibregl.Map): ViewState {
  return { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
}

interface ViewControlProps {
  map: maplibregl.Map | null;
}

export function ViewControl({ map }: ViewControlProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewState>(() => {
    const h = homeView();
    return { zoom: h.zoom, pitch: h.pitch, bearing: h.bearing };
  });
  const [orbit, setOrbit] = useState(false);
  const orbitRef = useRef<number | null>(null);

  useEffect(() => {
    if (!map) return;
    const sync = () => setView(readView(map));
    sync();
    map.on('move', sync);
    return () => {
      map.off('move', sync);
    };
  }, [map]);

  useEffect(() => {
    if (!map || !orbit) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      map.setBearing(map.getBearing() + dt * 8);
      orbitRef.current = requestAnimationFrame(tick);
    };
    orbitRef.current = requestAnimationFrame(tick);
    const stop = () => setOrbit(false);
    map.on('dragstart', stop);
    return () => {
      if (orbitRef.current != null) cancelAnimationFrame(orbitRef.current);
      map.off('dragstart', stop);
    };
  }, [map, orbit]);

  const ease = useCallback(
    (opts: { pitch?: number; bearing?: number; zoom?: number; center?: [number, number] }) => {
      setOrbit(false);
      map?.easeTo({ ...opts, duration: 600 });
    },
    [map]
  );

  if (!map) return null;
  const northUp = Math.abs(((view.bearing % 360) + 540) % 360 - 180) < 0.5;

  return (
    <div className="view-control" role="group" aria-label="View controls">
      {open && (
        <div className="view-control-panel glass-panel">
          <div className="view-control-head">
            <span>View</span>
            <button type="button" className="view-btn" aria-label="Close view controls" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <label className="view-row">
            <span>Tilt</span>
            <input
              type="range"
              min={0}
              max={85}
              step={1}
              value={Math.round(view.pitch)}
              onChange={(e) => map.jumpTo({ pitch: Number(e.target.value) })}
              aria-label="Tilt"
            />
            <output>{Math.round(view.pitch)}°</output>
          </label>
          <label className="view-row">
            <span>Rotate</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={Math.round(((view.bearing + 540) % 360) - 180)}
              onChange={(e) => map.jumpTo({ bearing: Number(e.target.value) })}
              aria-label="Rotate"
            />
            <output>{Math.round(((view.bearing + 540) % 360) - 180)}°</output>
          </label>
          <div className="view-presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="view-chip"
                onClick={() => ease({ pitch: p.pitch, ...(p.bearing != null ? { bearing: p.bearing } : p.id === 'oblique' ? { bearing: homeView().bearing } : {}) })}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className={`view-chip ${orbit ? 'active' : ''}`}
              aria-pressed={orbit}
              onClick={() => setOrbit((v) => !v)}
            >
              <RotateCw size={12} /> Orbit
            </button>
            <button
              type="button"
              className="view-chip"
              onClick={() => ease({ ...homeView() })}
            >
              Home
            </button>
          </div>
        </div>
      )}
      <div className="view-control-bar glass-panel">
        <button type="button" className="view-btn" aria-label="Zoom in" onClick={() => map.zoomIn({ duration: 300 })}>
          <Plus size={16} />
        </button>
        <button type="button" className="view-btn" aria-label="Zoom out" onClick={() => map.zoomOut({ duration: 300 })}>
          <Minus size={16} />
        </button>
        <button
          type="button"
          className="view-btn"
          aria-label="Reset north"
          title={northUp ? 'North is up' : 'Reset north'}
          onClick={() => ease({ bearing: 0 })}
        >
          <Compass size={16} style={{ transform: `rotate(${-view.bearing}deg)` }} />
        </button>
        <button
          type="button"
          className={`view-btn ${open ? 'active' : ''}`}
          aria-label="View controls"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <SlidersHorizontal size={16} />
        </button>
      </div>
    </div>
  );
}
