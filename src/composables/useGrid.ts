import { ref } from 'vue';
import type VectorTileLayer from 'ol/layer/VectorTile';
import OlMap from 'ol/Map';
import type Map from 'ol/Map';
import View from 'ol/View';
import type MapBrowserEvent from 'ol/MapBrowserEvent';
import { MapboxVectorLayer, setFeatureState } from 'ol-mapbox-style';
import type LayerGroup from 'ol/layer/Group';
import { Feature as OlFeature } from 'ol';
import { Polygon } from 'ol/geom';
import type { FeatureLike } from 'ol/Feature';
import RenderFeature, { toFeature } from 'ol/render/Feature';
import { fromLonLat } from 'ol/proj';
import { inverse } from 'mgrs';
import { boundingExtent } from 'ol/extent';
import type { Polygon as GeoJSONPolygon, MultiPolygon as GeoJSONMultiPolygon } from 'geojson';
import polygonClipping from 'polygon-clipping';
import GeoJSON from 'ol/format/GeoJSON';
import { useEdit } from './useEdit';

const { editMode, gridSnapSource } = useEdit();

const gridVisible = ref(false);
const selectedGridCellId = ref<string | undefined>(undefined);

let grid: VectorTileLayer | undefined;
let gridMap: Map | undefined;
let gridMapGroup: LayerGroup | undefined;

const updateGridVisibility = () => {
  if (grid) {
    gridVisible.value = grid.isVisible();
  }
};

/**
 * Compute the projected extent of a 2×2 km grid cell from its MGRS ID.
 * Uses simple easting/northing offset to find the NE 1km cell, then
 * takes the SW corner of the SW cell and NE corner of the NE cell.
 */
function gridCellExtent(gridCellId: string) {
  const mgrs = gridCellId.replace(/^ftw-/, '');
  const match = mgrs.match(/^(\d{1,2}[A-Z][A-Z]{2})(\d+)$/);
  if (!match) return undefined;
  const prefix = match[1]!;
  const digits = match[2]!;
  const half = digits.length / 2;
  const easting = parseInt(digits.slice(0, half), 10);
  const northing = parseInt(digits.slice(half), 10);
  const pad = (n: number) => n.toString().padStart(half, '0');
  const swBbox = inverse(prefix + pad(easting) + pad(northing));
  const neBbox = inverse(prefix + pad(easting + 1) + pad(northing + 1));
  const ll: [number, number] = [swBbox[0], swBbox[1]];
  const ur: [number, number] = [neBbox[2], neBbox[3]];
  return boundingExtent([fromLonLat(ll), fromLonLat(ur)]);
}

// ---- Offscreen map for fetching accurate grid cell geometry from PMTiles ----

const format = new GeoJSON();

let offscreenMap: Promise<Map> | undefined;
let offscreenGrid: Promise<VectorTileLayer> | undefined;

async function getOffscreenGrid(): Promise<VectorTileLayer> {
  if (!offscreenGrid) {
    const gridLayer = new MapboxVectorLayer({
      styleUrl: './style.json',
      source: 'ftw-grid',
    });
    offscreenGrid = new Promise((resolve) => {
      const source = gridLayer.getSource()!;
      source.on('change', function unregister() {
        if (source.getState() !== 'ready') {
          return;
        }
        source.un('change', unregister);
        resolve(gridLayer);
      });
    });
  }
  return offscreenGrid;
}

async function getOffscreenMap(): Promise<Map> {
  if (!offscreenMap) {
    offscreenMap = new Promise(async (resolve) => {
      const map = new OlMap({
        target: document.createElement('div'),
        layers: [await getOffscreenGrid()],
        view: new View({ center: [0, 0], zoom: 2 }),
        controls: [],
        interactions: [],
        pixelRatio: 1,
      });
      map.setSize([512, 512]);
      resolve(map);
    });
  }
  return offscreenMap;
}

/**
 * Fetch the accurate grid cell polygon from PMTiles using an offscreen map.
 * Fits view to the computed extent, waits for tiles to render, collects all
 * features with the given ID (may be split at tile boundaries), and merges
 * them with polygon-clipping.
 */
async function fetchGridCellFeature(gridCellId: string): Promise<OlFeature<Polygon> | undefined> {
  const extent = gridCellExtent(gridCellId);
  if (!extent) return undefined;

  const map = await getOffscreenMap();
  const grid = await getOffscreenGrid();

  // Fit view to grid cell extent
  map.getView().fit(extent);
  map.render();

  // Wait for tiles to load
  await new Promise<void>((resolve) => {
    map.once('rendercomplete', () => resolve());
  });

  // Collect all features with the grid cell ID (may be duplicated across tile boundaries)
  const features = grid.getFeaturesInExtent(extent);
  const matching = features.filter((f: FeatureLike) => f.get('id') === gridCellId);
  if (matching.length === 0) return undefined;

  if (matching.length === 1) {
    return toFeature(matching[0] as RenderFeature) as OlFeature<Polygon>;
  }

  // Merge fragments with polygon-clipping
  const projection = map.getView().getProjection();
  const polys: polygonClipping.MultiPolygon = [];
  for (const f of matching) {
    const gj = format.writeFeatureObject(toFeature(f as RenderFeature), {
      featureProjection: projection,
    });
    if (gj.geometry.type === 'Polygon') {
      polys.push((gj.geometry as GeoJSONPolygon).coordinates as polygonClipping.Polygon);
    } else if (gj.geometry.type === 'MultiPolygon') {
      polys.push(
        ...((gj.geometry as GeoJSONMultiPolygon).coordinates as polygonClipping.MultiPolygon),
      );
    }
  }
  if (polys.length === 0) return undefined;

  const merged =
    polys.length === 1 ? [polys[0]!] : polygonClipping.union(polys[0]!, ...polys.slice(1));

  if (merged.length === 0) return undefined;
  const coords = merged.length === 1 ? merged[0] : merged[0]; // always use first polygon
  return format.readFeature(
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: coords } },
    { featureProjection: projection },
  ) as OlFeature<Polygon>;
}

/**
 * Set the grid snap feature from a grid cell ID.
 * Fetches the accurate geometry from PMTiles via the offscreen map.
 */
async function setGridSnapFeature(gridCellId: string) {
  gridSnapSource.clear();
  const feature = await fetchGridCellFeature(gridCellId);
  if (feature) {
    gridSnapSource.addFeature(feature);
  }
}

function zoomToExtent(map: Map, extent: number[]) {
  const view = map.getView();
  const size = map.getSize();
  if (!size) return;
  const [width, height] = size;
  const padding = [height! * 0.125, width! * 0.125, height! * 0.125, width! * 0.125];
  view.fit(extent, { padding, duration: 500 });
}

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
  const id = feature.get('id');
  selectedGridCellId.value = id;
  setFeatureState(mapGroup, { source: 'ftw-grid', id }, { selected: true });
  setGridSnapFeature(id);
  const extent = gridCellExtent(id);
  if (extent) {
    zoomToExtent(map, extent);
  }
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

export function initGrid(
  layer: VectorTileLayer,
  map: Map,
  mapGroup: LayerGroup,
  initialGridCellId?: string,
) {
  grid = layer;
  gridMap = map;
  gridMapGroup = mapGroup;
  map.on('rendercomplete', updateGridVisibility);
  map.on('singleclick', (event) => {
    if (editMode.value) return;
    enableGridCellSelection(event);
    selectGridCell(event, mapGroup);
  });

  // Restore grid cell selection from hash
  if (initialGridCellId) {
    selectGridCellById(initialGridCellId);
  }
}

function selectGridCellById(id: string | undefined) {
  if (!grid || !gridMap || !gridMapGroup) return;
  const map = gridMap;
  const mapGroup = gridMapGroup;

  // Deselect current
  if (selectedGridCellId.value) {
    setFeatureState(
      mapGroup,
      { source: 'ftw-grid', id: selectedGridCellId.value },
      { selected: null },
    );
    gridSnapSource.clear();
  }

  if (!id) {
    selectedGridCellId.value = undefined;
    return;
  }

  // Set the feature state immediately for styling
  setFeatureState(mapGroup, { source: 'ftw-grid', id }, { selected: true });
  selectedGridCellId.value = id;

  // Zoom and set snap/split geometry — all computed from the ID
  const extent = gridCellExtent(id);
  if (extent) {
    zoomToExtent(map, extent);
  }
  setGridSnapFeature(id);
}

export function useGrid() {
  return {
    gridVisible,
    selectedGridCellId,
    selectGridCellById,
  };
}
