import { FileUp, Globe, Sparkles, Upload, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  createGeoJsonLayerDef,
  createRemotePmtilesLayerDef,
} from '../layers/customVectorLoader';
import { useTwinStore } from '../layers/registry';

interface AddLayerModalProps {
  open: boolean;
  onClose: () => void;
  onNotify: (message: string) => void;
}

type ModalTab = 'upload' | 'url';
type UrlFormat = 'auto' | 'geojson' | 'pmtiles';

function buildSampleFloodGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'flood-mandalagan-creek',
        properties: {
          id: 'flood-mandalagan-creek',
          name: 'Mandalagan Creek Floodplain',
          zone_type: 'Riverine Drainage Corridor',
          risk_level: 'High',
          depth_m: 2.6,
          return_period_yr: 25,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [122.9482, 10.6882],
              [122.9568, 10.6875],
              [122.9584, 10.6844],
              [122.9476, 10.6851],
              [122.9482, 10.6882],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'flood-lupit-river',
        properties: {
          id: 'flood-lupit-river',
          name: 'Lupit River Basin',
          zone_type: 'Tidal & Riverine Surge',
          risk_level: 'High',
          depth_m: 3.1,
          return_period_yr: 25,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [122.9425, 10.6632],
              [122.9532, 10.6624],
              [122.9544, 10.6592],
              [122.9418, 10.6601],
              [122.9425, 10.6632],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'flood-reclamation-outfall',
        properties: {
          id: 'flood-reclamation-outfall',
          name: 'Reclamation Coastal Outfall',
          zone_type: 'Storm Surge & Urban Retention',
          risk_level: 'Moderate',
          depth_m: 1.5,
          return_period_yr: 10,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [122.9378, 10.6736],
              [122.9436, 10.6738],
              [122.9434, 10.6691],
              [122.9374, 10.6694],
              [122.9378, 10.6736],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'flood-banago-drainage',
        properties: {
          id: 'flood-banago-drainage',
          name: 'Banago–Bata Creek Collector',
          zone_type: 'Urban Drainage Channel',
          risk_level: 'Moderate',
          depth_m: 1.9,
          return_period_yr: 10,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [122.9502, 10.6968],
              [122.9595, 10.6962],
              [122.9601, 10.6934],
              [122.9498, 10.6941],
              [122.9502, 10.6968],
            ],
          ],
        },
      },
    ],
  };
}

export function AddLayerModal({
  open,
  onClose,
  onNotify,
}: AddLayerModalProps) {
  const { registerLayer } = useTwinStore();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [tab, setTab] = useState<ModalTab>('upload');
  const [layerName, setLayerName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [urlFormat, setUrlFormat] = useState<UrlFormat>('auto');
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const handleFile = async (file: File) => {
    setError(null);
    setLoading(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as GeoJSON.GeoJSON;
      if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
        throw new Error('File does not contain a valid GeoJSON object.');
      }

      const derivedName =
        layerName.trim() ||
        file.name.replace(/\.(geo)?json$/i, '') ||
        'Uploaded GeoJSON';

      const def = createGeoJsonLayerDef({
        name: derivedName,
        geojson: parsed,
      });
      registerLayer(def);
      setLayerName('');
      onNotify(`Mounted GeoJSON layer "${derivedName}"`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse GeoJSON file.');
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFile(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFile(file);
    }
  };

  const handleLoadSample = () => {
    setError(null);
    const sampleGeoJson = buildSampleFloodGeoJson();
    const def = createGeoJsonLayerDef({
      name: 'Bacolod Flood & Drainage Demo',
      description:
        'Sample creek & reclamation flood-depth zones (depth_m extruded 8x).',
      geojson: sampleGeoJson,
      defaultStyle: {
        fillColor: '#06b6d4',
        lineColor: '#67e8f9',
        lineWidth: 2,
        extruded: true,
        elevationProperty: 'depth_m',
        elevationScale: 8,
      },
    });
    registerLayer(def);
    onNotify('Loaded Bacolod Flood/Drainage Demo (3D extruded by depth_m)');
    onClose();
  };

  const handleRemoteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedUrl = remoteUrl.trim();
    if (!trimmedUrl) {
      setError('Enter a GeoJSON or PMTiles URL.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const detectedFormat: 'geojson' | 'pmtiles' =
        urlFormat === 'auto'
          ? trimmedUrl.toLowerCase().includes('.pmtiles') ||
            trimmedUrl.startsWith('pmtiles://')
            ? 'pmtiles'
            : 'geojson'
          : urlFormat;

      const cleanName =
        layerName.trim() ||
        trimmedUrl.split('/').pop()?.replace(/\.(pmtiles|geojson|json).*$/i, '') ||
        `Remote ${detectedFormat.toUpperCase()}`;

      if (detectedFormat === 'pmtiles') {
        const def = await createRemotePmtilesLayerDef({
          name: cleanName,
          url: trimmedUrl,
        });
        registerLayer(def);
      } else {
        const res = await fetch(trimmedUrl);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} while fetching GeoJSON URL.`);
        }
        const geojson = (await res.json()) as GeoJSON.GeoJSON;
        const def = createGeoJsonLayerDef({
          name: cleanName,
          geojson,
          sourceUrl: trimmedUrl,
        });
        registerLayer(def);
      }

      setLayerName('');
      setRemoteUrl('');
      onNotify(`Mounted remote layer "${cleanName}"`);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load remote vector layer.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="hud-modal"
      aria-labelledby="add-layer-modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="hud-modal-content">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div>
            <h2
              id="add-layer-modal-title"
              style={{ margin: 0, fontSize: 15, fontWeight: 700 }}
            >
              Add 3D / Vector Layer
            </h2>
            <p
              style={{
                margin: '2px 0 0',
                fontSize: 11.5,
                color: 'var(--text-muted)',
              }}
            >
              Mount local GeoJSON or remote GeoJSON / PMTiles interleaved with buildings
            </p>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X size={16} />
          </button>
        </div>

        <div className="segmented-control" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'upload'}
            className={`segmented-btn ${tab === 'upload' ? 'active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => {
              setTab('upload');
              setError(null);
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Upload size={13} /> GeoJSON File
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'url'}
            className={`segmented-btn ${tab === 'url' ? 'active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => {
              setTab('url');
              setError(null);
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Globe size={13} /> Remote URL
            </span>
          </button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            Layer Name (optional)
          </span>
          <input
            type="text"
            className="text-input"
            placeholder="e.g. Bacolod Drainage Zones"
            value={layerName}
            onChange={(e) => setLayerName(e.target.value)}
          />
        </label>

        {tab === 'upload' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              className={`drop-zone ${dragOver ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <FileUp
                size={24}
                style={{ color: 'var(--accent)', marginBottom: 6 }}
              />
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                {loading
                  ? 'Parsing GeoJSON…'
                  : 'Drop .geojson or .json file here, or click to browse'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                Numeric attributes are auto-detected for 3D extrusion
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".geojson,.json,application/geo+json,application/json"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </div>

            <button
              type="button"
              className="btn"
              onClick={handleLoadSample}
              style={{ justifyContent: 'center' }}
            >
              <Sparkles size={14} style={{ color: 'var(--accent)' }} />
              Load Sample Bacolod Flood/Drainage Demo GeoJSON
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => void handleRemoteSubmit(e)}
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                GeoJSON or PMTiles URL
              </span>
              <input
                type="url"
                className="text-input"
                placeholder="https://example.com/bacolod-overlay.geojson"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                required
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                Format
              </span>
              <select
                className="select-input"
                value={urlFormat}
                onChange={(e) => setUrlFormat(e.target.value as UrlFormat)}
              >
                <option value="auto">Auto-detect (.pmtiles vs GeoJSON)</option>
                <option value="geojson">GeoJSON (deck.gl interleaved)</option>
                <option value="pmtiles">PMTiles Vector Archive (MapLibre)</option>
              </select>
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? 'Loading…' : 'Mount URL Layer'}
              </button>
            </div>
          </form>
        )}

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--danger-soft)',
              color: 'var(--danger)',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </dialog>
  );
}
