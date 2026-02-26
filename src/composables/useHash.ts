import { watch } from 'vue';
import { toLonLat, fromLonLat } from 'ol/proj';
import type Map from 'ol/Map';
import { useGrid } from './useGrid';

let map: Map;
let updatingHash = false;

const { selectedGridCellId } = useGrid();

function parseHash(): { center?: [number, number]; zoom?: number; gridCellId?: string } {
  const hash = window.location.hash.replace('#', '');
  if (!hash) return {};
  const parts = hash.split('/');
  const result: { center?: [number, number]; zoom?: number; gridCellId?: string } = {};

  if (parts.length >= 3) {
    const zoom = parseFloat(parts[0]!);
    const lat = parseFloat(parts[1]!);
    const lon = parseFloat(parts[2]!);
    if (!isNaN(zoom) && !isNaN(lat) && !isNaN(lon)) {
      result.zoom = zoom;
      result.center = [lon, lat];
    }
  }
  if (parts.length >= 4 && parts[3]) {
    result.gridCellId = parts[3];
  }
  return result;
}

function updateHash() {
  if (!map) return;
  updatingHash = true;
  const view = map.getView();
  const center = view.getCenter();
  const zoom = view.getZoom();
  if (!center || zoom === undefined) {
    updatingHash = false;
    return;
  }
  const [lon, lat] = toLonLat(center);
  const parts = [zoom.toFixed(2), lat!.toFixed(5), lon!.toFixed(5)];
  if (selectedGridCellId.value) {
    parts.push(selectedGridCellId.value);
  }
  window.location.hash = parts.join('/');
  updatingHash = false;
}

export function initHash(mapInstance: Map) {
  map = mapInstance;

  // Restore view from hash on load
  const { center, zoom, gridCellId } = parseHash();
  if (center && zoom !== undefined) {
    const view = map.getView();
    view.setCenter(fromLonLat(center));
    view.setZoom(zoom);
  }

  // Update hash on map move
  map.on('moveend', updateHash);

  // Update hash when grid cell selection changes
  watch(selectedGridCellId, () => {
    if (!updatingHash) {
      updateHash();
    }
  });

  // Return the grid cell ID from the hash for deferred selection
  return { gridCellId };
}
