import Map from 'ol/Map';
import View from 'ol/View';
import Group from 'ol/layer/Group';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import { apply } from 'ol-mapbox-style';
import { register as registerPMTilesProtocol } from 'pmtiles-protocol';
import { unByKey } from 'ol/Observable';

registerPMTilesProtocol();

const mgrs = new Group();
apply(mgrs, './style.json');

let map: Map;
function createMapInstance() {
  const map = new Map({
    controls: defaultControls({ attributionOptions: { collapsible: false } }),
    layers: [mgrs],
    view: new View({
      center: [0, 0],
      zoom: 2,
    }),
  });
  map.addControl(new ScaleLine());
  return map;
}

function enableAreaSelection(): () => void {
  const unKey = map.on('singleclick', (event) => {
    const view = map.getView();
    const zoom = view.getZoom();
    if (!zoom) {
      return;
    }
    if (zoom < 10) {
      view.animate({ center: event.coordinate, zoom: 10, duration: 500 });
    }
  });
  return () => unByKey(unKey);
}

export function useMap() {
  if (!map) {
    map = createMapInstance();
  }

  return {
    enableAreaSelection,
    map,
  };
}
