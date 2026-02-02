import { ref } from 'vue';
import type VectorTileLayer from 'ol/layer/VectorTile';
import type Map from 'ol/Map';
import type { MapBrowserEvent } from 'ol';
import { setFeatureState } from 'ol-mapbox-style';
import type LayerGroup from 'ol/layer/Group';
import { unByKey } from 'ol/Observable';

const gridVisible = ref(false);
let grid: VectorTileLayer | undefined;
let selectedGridCellId: string | undefined;

const updateGridVisibility = () => {
  if (grid) {
    gridVisible.value = grid.isVisible();
  }
};

const selectGridCell = async (event: MapBrowserEvent, mapGroup: LayerGroup) => {
  if (!grid) {
    return;
  }
  const map = event.target as Map;
  const feature = await map.forEachFeatureAtPixel(event.pixel, (feature) => feature, {
    layerFilter: (layer) => layer === grid,
  });
  if (selectedGridCellId) {
    setFeatureState(mapGroup, { source: 'mgrs', id: selectedGridCellId }, { selected: null });
    selectedGridCellId = undefined;
  }
  if (!feature) {
    return;
  }
  selectedGridCellId = feature.get('id');
  setFeatureState(mapGroup, { source: 'mgrs', id: feature.get('id') }, { selected: true });
};

const enableGridCellSelection = (event: MapBrowserEvent) => {
  if (gridVisible.value) {
    return;
  }
  const map = event.target as Map;
  const view = map.getView();
  const zoom = view.getZoom()!;
  if (zoom < 10) {
    view.animate({ center: event.coordinate, zoom: 10, duration: 500 });
  }
};

export function initGrid(layer: VectorTileLayer, map: Map, mapGroup: LayerGroup) {
  grid = layer;
  map.on('rendercomplete', updateGridVisibility);
  map.on('singleclick', (event) => {
    enableGridCellSelection(event);
    selectGridCell(event, mapGroup);
  });
}

export function useGrid() {
  return {
    gridVisible,
    enableGridCellSelection,
  };
}
