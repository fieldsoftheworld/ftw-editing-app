import Map from 'ol/Map';
import View from 'ol/View';
import Group from 'ol/layer/Group';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import { apply, getLayer } from 'ol-mapbox-style';
import { register as registerPMTilesProtocol } from 'pmtiles-protocol';
import type VectorTileLayer from 'ol/layer/VectorTile';
import { initGrid } from './useGrid';
import RenderFeature from 'ol/render/Feature';

registerPMTilesProtocol();

// Extend RenderFeature to fall back to the `id` property if the internal id is not set
// This is needed because the mgrs grid features have their id set as a id property only
RenderFeature.prototype.getId = function () {
  return this.get('id') ?? this.getProperties().id;
};

let map: Map;
const mapGroup = new Group();
apply(mapGroup, './style.json').then(() => {
  const grid = getLayer(mapGroup, 'mgrs') as VectorTileLayer;
  initGrid(grid, map, mapGroup);
});

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
