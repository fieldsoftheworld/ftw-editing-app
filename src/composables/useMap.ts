import Map from 'ol/Map';
import View from 'ol/View';
import Group from 'ol/layer/Group';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import { apply, getLayer } from 'ol-mapbox-style';
import { register as registerPMTilesProtocol } from 'pmtiles-protocol';
import type VectorTileLayer from 'ol/layer/VectorTile';
import { initGrid } from './useGrid';
import { initEdit } from './useEdit';
import { initHash } from './useHash';
import RenderFeature from 'ol/render/Feature';

registerPMTilesProtocol();

// Extend RenderFeature to fall back to the `id` property if the internal id is not set
// This is needed because the ftw-grid grid features have their id set as a id property only
RenderFeature.prototype.getId = function () {
  return this.get('id') ?? this.getProperties().id;
};

let map: Map;
const mapGroup = new Group();

function onStyleLoaded(gridCellId?: string) {
  const grid = getLayer(mapGroup, 'ftw-grid') as VectorTileLayer;
  initGrid(grid, map, mapGroup, gridCellId);
  initEdit(map);
}

apply(mapGroup, './style.json').then(() => {
  // initHash must be called after map is created but style may load before or after
  // We store the gridCellId and pass it through on style load
  if (map) {
    const { gridCellId } = initHash(map);
    onStyleLoaded(gridCellId);
  } else {
    // Style loaded before map was created - will be handled in createMapInstance
    pendingStyleLoad = true;
  }
});

let pendingStyleLoad = false;

function createMapInstance() {
  const map = new Map({
    controls: defaultControls({ attributionOptions: { collapsible: false } }),
    layers: [mapGroup],
    view: new View({
      center: [0, 0],
      zoom: 2,
    }),
  });
  map.addControl(new ScaleLine());
  if (pendingStyleLoad) {
    const { gridCellId } = initHash(map);
    onStyleLoaded(gridCellId);
    pendingStyleLoad = false;
  }
  return map;
}

export function useMap() {
  if (!map) {
    map = createMapInstance();
  }

  return {
    map,
  };
}
