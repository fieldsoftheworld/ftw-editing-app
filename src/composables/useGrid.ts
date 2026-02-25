import { ref } from 'vue';
import type VectorTileLayer from 'ol/layer/VectorTile';
import type Map from 'ol/Map';
import type MapBrowserEvent from 'ol/MapBrowserEvent';
import { setFeatureState } from 'ol-mapbox-style';
import type LayerGroup from 'ol/layer/Group';
import type { FeatureLike } from 'ol/Feature';
import RenderFeature, { toFeature } from 'ol/render/Feature';
import { useEdit } from './useEdit';

const { editMode, gridSnapSource } = useEdit();

const gridVisible = ref(false);
const selectedGridCellId = ref<string | undefined>(undefined);

let grid: VectorTileLayer | undefined;

const updateGridVisibility = () => {
  if (grid) {
    gridVisible.value = grid.isVisible();
  }
};

const zoomToFeature = (map: Map, feature: FeatureLike) => {
  const geometry = feature.getGeometry();
  if (!geometry) {
    return;
  }
  const view = map.getView();
  const size = map.getSize();
  if (!size) {
    return;
  }
  const [width, height] = size;
  // Padding for 75% viewport usage (12.5% padding on each side)
  const padding = [height! * 0.125, width! * 0.125, height! * 0.125, width! * 0.125];
  view.fit(geometry.getExtent(), {
    padding,
    duration: 500,
  });
};

const selectGridCell = async (event: MapBrowserEvent, mapGroup: LayerGroup) => {
  if (!grid) {
    return;
  }
  const map = event.target as Map;
  const feature = map.forEachFeatureAtPixel(event.pixel, (feature) => feature, {
    layerFilter: (layer) => layer === grid,
  });
  if (selectedGridCellId.value) {
    setFeatureState(
      mapGroup,
      { source: 'ftw-grid', id: selectedGridCellId.value },
      { selected: null },
    );
    selectedGridCellId.value = undefined;
    gridSnapSource.clear();
  }
  if (!feature) {
    return;
  }
  selectedGridCellId.value = feature.get('id');
  setFeatureState(mapGroup, { source: 'ftw-grid', id: feature.get('id') }, { selected: true });
  gridSnapSource.clear();
  gridSnapSource.addFeature(toFeature(feature as RenderFeature));
  zoomToFeature(map, feature);
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
    if (editMode.value) return;
    enableGridCellSelection(event);
    selectGridCell(event, mapGroup);
  });
}

export function useGrid() {
  return {
    gridVisible,
    selectedGridCellId,
  };
}
