import type maplibregl from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AddLayerModal } from './components/AddLayerModal';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { FeatureInspector } from './components/FeatureInspector';
import { LayerDock } from './components/LayerDock';
import { LegendBar } from './components/LegendBar';
import { MeasureControl, type MeasureMode } from './components/MeasureControl';
import { MobilityPlaybackBar } from './components/MobilityPlaybackBar';
import { ReportsPanel } from './components/ReportsPanel';
import { TopBar } from './components/TopBar';
import { TwinViewport } from './components/TwinViewport';
import { TwinStoreProvider, useTwinStore } from './layers/registry';

function TwinWorkspace() {
  const { theme, layerState, activeView, setActiveView, toggleLayer, setMobilityPlaying, setSelectedFeature } =
    useTwinStore();
  const mobilityVisible = Boolean(layerState.mobility?.visible);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);
  const [measureMode, setMeasureMode] = useState<MeasureMode>('off');
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  const [profileHoverCoord, setProfileHoverCoord] = useState<
    [number, number] | null
  >(null);
  const [sitePickMode, setSitePickMode] = useState(false);
  const [siteCenter, setSiteCenter] = useState<[number, number] | null>(null);
  const [siteRadiusM, setSiteRadiusM] = useState<300 | 500 | 1000>(500);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    const resolvedTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [theme]);

  // The mobility layer belongs to the Simulate view: on when entering, off when leaving.
  useEffect(() => {
    const simulating = activeView === 'simulate';
    toggleLayer('mobility', simulating);
    setMobilityPlaying(simulating);
  }, [activeView, toggleLayer, setMobilityPlaying]);

  // Site picking and measuring only make sense next to the Analyze view.
  useEffect(() => {
    if (activeView !== 'analyze') setSitePickMode(false);
  }, [activeView]);

  // Esc closes the building / barangay inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedFeature(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSelectedFeature]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const notify = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 3000);
  }, []);

  const handleMapReady = useCallback((map: maplibregl.Map | null) => {
    mapRef.current = map;
    setMapInstance(map);
  }, []);

  const handleFlyTo = useCallback(
    (camera: {
      center: [number, number];
      zoom?: number;
      pitch?: number;
      bearing?: number;
    }) => {
      const map = mapRef.current;
      if (!map) return;
      map.flyTo({
        center: camera.center,
        zoom: camera.zoom ?? 15.6,
        pitch: camera.pitch ?? 56,
        bearing: camera.bearing ?? -18,
        duration: 1400,
        essential: true,
      });
    },
    []
  );

  const handleFitBounds = useCallback(
    (bbox: [number, number, number, number]) => {
      const map = mapRef.current;
      if (!map) return;
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        {
          padding: { top: 90, bottom: 80, left: 350, right: 360 },
          pitch: 50,
          duration: 1300,
          maxZoom: 16.5,
        }
      );
    },
    []
  );

  const handleAddMeasurePoint = useCallback((coord: [number, number]) => {
    setMeasurePoints((prev) => [...prev, coord]);
  }, []);

  const handleToggleMeasure = useCallback(() => {
    setMeasureMode((prev) => {
      if (prev === 'off') {
        setSitePickMode(false);
        return 'distance';
      }
      setMeasurePoints([]);
      setProfileHoverCoord(null);
      return 'off';
    });
  }, []);

  const handleChangeMeasureMode = useCallback((next: MeasureMode) => {
    setMeasureMode(next);
    setMeasurePoints([]);
    setProfileHoverCoord(null);
  }, []);

  const handleToggleSitePickMode = useCallback((next: boolean) => {
    setSitePickMode(next);
    if (next) {
      setMeasureMode('off');
      setMeasurePoints([]);
      setProfileHoverCoord(null);
    }
  }, []);

  const handlePickSite = useCallback((coord: [number, number]) => {
    setSiteCenter(coord);
    setSitePickMode(false);
  }, []);

  return (
    <main className={`twin-shell ${mobilityVisible ? 'has-mobility-bar' : ''}`}>
      <TwinViewport
        measureMode={measureMode}
        measurePoints={measurePoints}
        onAddMeasurePoint={handleAddMeasurePoint}
        sitePickMode={sitePickMode}
        siteCenter={siteCenter}
        siteRadiusM={siteRadiusM}
        onPickSite={handlePickSite}
        profileHoverCoord={profileHoverCoord}
        onMapReady={handleMapReady}
        onNotify={notify}
      />

      <TopBar
        measureMode={measureMode}
        onToggleMeasure={handleToggleMeasure}
        onFlyTo={handleFlyTo}
        onFitBounds={handleFitBounds}
        onNotify={notify}
      />

      {activeView !== 'reports' && <LayerDock onOpenAddModal={() => setAddModalOpen(true)} />}

      {activeView === 'reports' && <ReportsPanel onClose={() => setActiveView('explore')} />}

      <div className="hud-right-rail">
        <AnalyticsPanel
          open={activeView === 'analyze' || activeView === 'simulate'}
          view={activeView === 'simulate' ? 'simulate' : 'analyze'}
          onClose={() => {
            setActiveView('explore');
            setSitePickMode(false);
          }}
          sitePickMode={sitePickMode}
          onToggleSitePickMode={handleToggleSitePickMode}
          siteCenter={siteCenter}
          siteRadiusM={siteRadiusM}
          onChangeSiteRadius={setSiteRadiusM}
          onClearSite={() => setSiteCenter(null)}
          onFlyTo={handleFlyTo}
          onFitBounds={handleFitBounds}
        />
        {activeView !== 'reports' && <FeatureInspector onFlyTo={handleFlyTo} />}
      </div>

      <MeasureControl
        mode={measureMode}
        points={measurePoints}
        map={mapInstance}
        onChangeMode={handleChangeMeasureMode}
        onUndo={() => setMeasurePoints((prev) => prev.slice(0, -1))}
        onClear={() => {
          setMeasurePoints([]);
          setProfileHoverCoord(null);
        }}
        onClose={() => {
          setMeasureMode('off');
          setMeasurePoints([]);
          setProfileHoverCoord(null);
        }}
        onHoverProfileCoord={setProfileHoverCoord}
      />

      <LegendBar />

      <MobilityPlaybackBar />

      <AddLayerModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onNotify={notify}
      />

      {toastMessage && (
        <div className="hud-toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </main>
  );
}

export default function App() {
  return (
    <TwinStoreProvider>
      <TwinWorkspace />
    </TwinStoreProvider>
  );
}
