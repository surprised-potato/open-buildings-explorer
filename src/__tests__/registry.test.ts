import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGeoJsonLayerDef,
  DEFAULT_CUSTOM_STYLE,
  inspectGeoJsonProperties,
} from '../layers/customVectorLoader';
import { TwinStoreProvider, useTwinStore } from '../layers/registry';

describe('customVectorLoader & TwinStore registry', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = '';
    vi.restoreAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      })
    );
  });

  describe('inspectGeoJsonProperties', () => {
    it('extracts all and finite numeric properties from a FeatureCollection', () => {
      const fc: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: 'Mandalagan Creek',
              depth_m: 1.8,
              risk_score: 4,
              invalid_num: Number.NaN,
            },
            geometry: { type: 'Point', coordinates: [122.95, 10.68] },
          },
          {
            type: 'Feature',
            properties: {
              barangay: 'Mandalagan',
              depth_m: 2.4,
            },
            geometry: { type: 'Point', coordinates: [122.951, 10.681] },
          },
        ],
      };

      const inspected = inspectGeoJsonProperties(fc);
      expect(inspected.allProperties).toEqual([
        'name',
        'depth_m',
        'risk_score',
        'invalid_num',
        'barangay',
      ]);
      expect(inspected.numericProperties).toEqual(['depth_m', 'risk_score']);
    });

    it('handles single Features and invalid inputs gracefully', () => {
      const feature: GeoJSON.Feature = {
        type: 'Feature',
        properties: { label: 'Zone A', height: 12 },
        geometry: { type: 'Point', coordinates: [122.95, 10.67] },
      };

      expect(inspectGeoJsonProperties(feature)).toEqual({
        allProperties: ['label', 'height'],
        numericProperties: ['height'],
      });
      expect(inspectGeoJsonProperties(null)).toEqual({
        allProperties: [],
        numericProperties: [],
      });
      expect(inspectGeoJsonProperties({ type: 'Point' })).toEqual({
        allProperties: [],
        numericProperties: [],
      });
    });
  });

  describe('createGeoJsonLayerDef', () => {
    const sampleGeoJson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'creek-1',
          properties: { name: 'Lupit Flood Zone', depth_m: 2.5, count: 10 },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [122.948, 10.662],
                [122.95, 10.662],
                [122.95, 10.664],
                [122.948, 10.664],
                [122.948, 10.662],
              ],
            ],
          },
        },
      ],
    };

    it('selects preferred elevation property and builds a deck GeoJsonLayer', () => {
      const def = createGeoJsonLayerDef({
        id: 'test-flood-layer',
        name: 'Flood Zones',
        geojson: sampleGeoJson,
        defaultStyle: { extruded: true, elevationScale: 4 },
      });

      expect(def.id).toBe('test-flood-layer');
      expect(def.engine).toBe('deck');
      expect(def.removable).toBe(true);
      expect(def.numericProperties).toEqual(['depth_m', 'count']);
      expect(def.defaultStyle?.elevationProperty).toBe('depth_m');
      expect(def.defaultStyle?.extruded).toBe(true);

      const hiddenResult = def.buildDeckLayer?.({
        visible: false,
        opacity: 0.8,
        theme: 'dark',
        buildingColorMode: 'height',
        sunHour: 15.5,
        terrainEnabled: false,
        terrainExaggeration: 1,
        selectedFeature: null,
      });
      expect(hiddenResult).toBeNull();

      const onSelectFeature = vi.fn();
      const deckLayer = def.buildDeckLayer?.({
        visible: true,
        opacity: 0.8,
        theme: 'dark',
        buildingColorMode: 'height',
        sunHour: 15.5,
        terrainEnabled: false,
        terrainExaggeration: 1,
        style: def.defaultStyle,
        selectedFeature: null,
        onSelectFeature,
      });

      expect(deckLayer).not.toBeNull();
      const props = (deckLayer as unknown as { props: Record<string, unknown> })
        .props;
      expect(props.id).toBe('test-flood-layer-deck');
      expect(props.extruded).toBe(true);

      const getElevation = props.getElevation as (f: unknown) => number;
      expect(getElevation(sampleGeoJson.features[0])).toBe(10); // 2.5 * 4

      const onClick = props.onClick as (info: unknown) => boolean;
      const handled = onClick({
        object: sampleGeoJson.features[0],
        coordinate: [122.949, 10.663],
      });
      expect(handled).toBe(true);
      expect(onSelectFeature).toHaveBeenCalledWith({
        layerId: 'test-flood-layer',
        layerName: 'Flood Zones',
        id: 'creek-1',
        coordinates: [122.949, 10.663],
        properties: { name: 'Lupit Flood Zone', depth_m: 2.5, count: 10 },
      });
    });

    it('falls back to default elevation when extruded without elevationProperty', () => {
      const def = createGeoJsonLayerDef({
        name: 'No Numeric',
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { label: 'Only Text' },
              geometry: { type: 'Point', coordinates: [122.95, 10.67] },
            },
          ],
        },
        defaultStyle: {
          ...DEFAULT_CUSTOM_STYLE,
          extruded: true,
          elevationScale: 2,
        },
      });

      expect(def.defaultStyle?.elevationProperty).toBeNull();
      const deckLayer = def.buildDeckLayer?.({
        visible: true,
        opacity: 1,
        theme: 'light',
        buildingColorMode: 'clay',
        sunHour: 12,
        terrainEnabled: false,
        terrainExaggeration: 1,
        style: def.defaultStyle,
        selectedFeature: null,
      }) as unknown as { props: { getElevation: (f: unknown) => number } };

      expect(deckLayer.props.getElevation({ properties: {} })).toBe(20);
    });
  });

  describe('TwinStoreProvider & useTwinStore', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TwinStoreProvider, null, children);

    it('throws when useTwinStore is used outside TwinStoreProvider', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => renderHook(() => useTwinStore())).toThrow(
        'useTwinStore must be used inside a TwinStoreProvider'
      );
      errorSpy.mockRestore();
    });

    it('defaults buildingColorMode to class and omits standalone osm-pois point layer', () => {
      const { result } = renderHook(() => useTwinStore(), { wrapper });

      expect(result.current.buildingColorMode).toBe('class');
      expect(result.current.layers.some((l) => l.id === 'osm-pois')).toBe(
        false
      );
    });

    it('tracks selectedBarangayName and automatically shows boundaries when selected', () => {
      const { result } = renderHook(() => useTwinStore(), { wrapper });

      expect(result.current.selectedBarangayName).toBeNull();

      act(() => {
        result.current.toggleLayer('boundaries', false);
      });
      expect(result.current.layerState.boundaries?.visible).toBe(false);

      act(() => {
        result.current.setSelectedBarangayName('Villamonte');
      });
      expect(result.current.selectedBarangayName).toBe('Villamonte');
      expect(result.current.layerState.boundaries?.visible).toBe(true);

      act(() => {
        result.current.setSelectedBarangayName(null);
      });
      expect(result.current.selectedBarangayName).toBeNull();
    });

    it('defaults buildingConfidenceFilter to all and updates filter modes', () => {
      const { result } = renderHook(() => useTwinStore(), { wrapper });
      expect(result.current.buildingConfidenceFilter).toBe('all');

      act(() => {
        result.current.setBuildingConfidenceFilter('hide_inferred');
      });
      expect(result.current.buildingConfidenceFilter).toBe('hide_inferred');

      act(() => {
        result.current.setBuildingConfidenceFilter('verified_only');
      });
      expect(result.current.buildingConfidenceFilter).toBe('verified_only');
    });

    it('registers, styles, toggles, joins metrics, and unregisters layers', () => {
      const { result } = renderHook(() => useTwinStore(), { wrapper });

      expect(result.current.layers.length).toBeGreaterThanOrEqual(5);

      const customLayer = createGeoJsonLayerDef({
        id: 'custom-drainage',
        name: 'Drainage',
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { id: 'd1', depth_m: 1.5 },
              geometry: { type: 'Point', coordinates: [122.95, 10.67] },
            },
          ],
        },
      });

      act(() => {
        result.current.registerLayer(customLayer);
      });
      expect(
        result.current.layers.some((l) => l.id === 'custom-drainage')
      ).toBe(true);
      expect(result.current.layerState['custom-drainage']?.visible).toBe(true);

      act(() => {
        result.current.updateLayerStyle('custom-drainage', {
          fillColor: '#ef4444',
          extruded: true,
          elevationScale: 5,
        });
        result.current.setOpacity('custom-drainage', 1.5); // should clamp to 1
        result.current.toggleLayer('terrain', true);
      });

      expect(
        result.current.layerState['custom-drainage']?.style?.fillColor
      ).toBe('#ef4444');
      expect(result.current.layerState['custom-drainage']?.style?.extruded).toBe(
        true
      );
      expect(result.current.layerState['custom-drainage']?.opacity).toBe(1);
      expect(result.current.terrainEnabled).toBe(true);
      expect(result.current.layerState.terrain?.visible).toBe(true);

      act(() => {
        result.current.joinTabularMetrics('custom-drainage', [
          { id: 'd1', sensor_flow: 42.5, status: 'alert' },
        ]);
      });

      const updatedLayer = result.current.layers.find(
        (l) => l.id === 'custom-drainage'
      );
      expect(updatedLayer?.allProperties).toContain('sensor_flow');
      expect(updatedLayer?.allProperties).toContain('status');
      expect(updatedLayer?.numericProperties).toContain('sensor_flow');
      expect(updatedLayer?.numericProperties).not.toContain('status');

      act(() => {
        result.current.setSelectedFeature({
          layerId: 'custom-drainage',
          layerName: 'Drainage',
          properties: { id: 'd1' },
        });
      });
      expect(result.current.selectedFeature?.layerId).toBe('custom-drainage');

      act(() => {
        result.current.unregisterLayer('custom-drainage');
      });
      expect(
        result.current.layers.some((l) => l.id === 'custom-drainage')
      ).toBe(false);
      expect(result.current.selectedFeature).toBeNull();
    });
  });
});
