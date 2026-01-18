import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import Group from 'ol/layer/Group';
import { apply } from 'ol-mapbox-style';
import { register as registerPMTilesProtocol } from 'pmtiles-protocol';

registerPMTilesProtocol();

const mgrs = new Group();
apply(mgrs, {
  version: 8,
  name: 'MGRS Graticule',
  sources: {
    test: {
      type: 'raster',
      url: 'pmtiles://https://pmtiles.io/stamen_toner(raster)CC-BY+ODbL_z3.pmtiles',
    },
    mgrs: {
      type: 'vector',
      url: 'pmtiles://https://data.source.coop/ftw/ftw-grid/ftw_grid.pmtiles',
    },
  },
  layers: [
    {
      id: 'test',
      type: 'raster',
      source: 'test',
    },
    {
      id: 'mgrs',
      type: 'fill',
      source: 'mgrs',
      'source-layer': 'ftw_grid4',
      paint: {
        'fill-color': 'rgba(255, 0, 0, 0.1)',
        'fill-outline-color': 'rgba(255, 0, 0, 0.5)',
      },
    },
  ],
});

let map: Map;
function createMapInstance() {
  return new Map({
    layers: [mgrs],
    view: new View({
      center: [0, 0],
      zoom: 2,
    }),
  });
}

export function useMap() {
  if (!map) {
    map = createMapInstance();
  }

  return {
    map,
  };
}
