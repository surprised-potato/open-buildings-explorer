import { useMemo } from 'react';
import { getBuildingLegend } from '../layers/builtins';
import { getChoroplethLegend } from '../layers/builtins/boundariesLayer';
import { POI_CATEGORY_COLORS } from '../layers/builtins/buildingsLayer';
import { useTwinStore } from '../layers/registry';
import type { LegendItem } from '../layers/types';
import { SITE_CATEGORIES } from '../utils/siteSelection';

export function LegendBar() {
  const {
    layers,
    layerState,
    buildingColorMode,
    barangayChoropleth,
    poiCategoryFilter,
  } = useTwinStore();

  const items = useMemo<LegendItem[]>(() => {
    const result: LegendItem[] = [];

    if (barangayChoropleth !== 'off') {
      result.push(...getChoroplethLegend(barangayChoropleth));
    }

    const buildingsState = layerState.buildings;
    if (buildingsState?.visible !== false) {
      if (poiCategoryFilter !== 'all') {
        const catMeta = SITE_CATEGORIES.find((c) => c.value === poiCategoryFilter);
        result.push({
          label: `Filtered: ${catMeta?.label ?? poiCategoryFilter}`,
          color: POI_CATEGORY_COLORS[poiCategoryFilter] ?? '#f59e0b',
          shape: 'swatch',
        });
      } else {
        result.push(...getBuildingLegend(buildingColorMode));
      }
    }

    for (const layer of layers) {
      if (layer.id === 'buildings') continue;
      const state = layerState[layer.id];
      if (!state?.visible) continue;

      if (layer.category === 'custom') {
        const color = state.style?.fillColor ?? layer.defaultStyle?.fillColor ?? '#0ea5e9';
        result.push({
          label: layer.name,
          color,
          shape: 'swatch',
        });
      } else if (layer.legend && layer.legend.length > 0) {
        result.push(...layer.legend);
      }
    }

    return result;
  }, [
    layers,
    layerState,
    buildingColorMode,
    barangayChoropleth,
    poiCategoryFilter,
  ]);

  if (items.length === 0) return null;

  return (
    <aside className="hud-legend glass-panel" aria-label="Map legend">
      {items.map((item, idx) => (
        <div
          key={`${item.label}-${idx}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            color: 'var(--text-secondary)',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: item.shape === 'line' ? '14px' : '10px',
              height: item.shape === 'line' ? '3px' : '10px',
              borderRadius:
                item.shape === 'circle'
                  ? '999px'
                  : item.shape === 'line'
                    ? '2px'
                    : '3px',
              backgroundColor: item.color,
              flexShrink: 0,
            }}
          />
          <span>{item.label}</span>
        </div>
      ))}
    </aside>
  );
}
