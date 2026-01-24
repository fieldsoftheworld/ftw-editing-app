import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import Group from 'ol/layer/Group';
import { defaults as defaultControls } from 'ol/control';
import { apply } from 'ol-mapbox-style';
import { register as registerPMTilesProtocol } from 'pmtiles-protocol';

registerPMTilesProtocol();

const mgrs = new Group();
apply(mgrs, './style.json');

let map: Map;
function createMapInstance() {
  return new Map({
    controls: defaultControls({ attributionOptions: { collapsible: false } }),
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
