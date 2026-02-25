import { ref, watch } from 'vue';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import Draw from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Snap from 'ol/interaction/Snap';
import { Fill, Stroke, Style } from 'ol/style';
import GeoJSON from 'ol/format/GeoJSON';
import type {
  LineString as GeoJSONLineString,
  Polygon as GeoJSONPolygon,
  MultiPolygon as GeoJSONMultiPolygon,
} from 'geojson';
import polygonClipping from 'polygon-clipping';
import type { Feature } from 'ol';
import type { Polygon } from 'ol/geom';
import type Map from 'ol/Map';
import type MapBrowserEvent from 'ol/MapBrowserEvent';

export type EditMode = 'draw' | 'split' | 'delete' | null;

const editMode = ref<EditMode>(null);

const editSource = new VectorSource();
const editLayer = new VectorLayer({
  source: editSource,
  style: [
    new Style({
      stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.7)', width: 4 }),
      zIndex: 0,
    }),
    new Style({
      fill: new Fill({ color: 'rgba(0, 200, 255, 0.08)' }),
      stroke: new Stroke({ color: 'rgba(0, 200, 255, 1)', width: 2 }),
      zIndex: 1,
    }),
  ],
});

const splitSource = new VectorSource();
const splitLayer = new VectorLayer({
  source: splitSource,
  style: new Style({
    stroke: new Stroke({ color: 'rgba(255, 200, 0, 0.9)', width: 2 }),
  }),
});

const gridSnapSource = new VectorSource();

const format = new GeoJSON();

let map: Map | undefined;
let drawPolygon: Draw | undefined;
let drawLine: Draw | undefined;
let modify: Modify | undefined;
let snap: Snap | undefined;
let gridSnap: Snap | undefined;
let deleteClickHandler: ((event: MapBrowserEvent<PointerEvent>) => void) | undefined;

function removeInteractions() {
  if (!map) return;
  if (drawPolygon) {
    map.removeInteraction(drawPolygon);
    drawPolygon = undefined;
  }
  if (drawLine) {
    map.removeInteraction(drawLine);
    drawLine = undefined;
  }
  if (modify) {
    map.removeInteraction(modify);
    modify = undefined;
  }
  if (snap) {
    map.removeInteraction(snap);
    snap = undefined;
  }
  if (gridSnap) {
    map.removeInteraction(gridSnap);
    gridSnap = undefined;
  }
  if (deleteClickHandler) {
    map.un('singleclick', deleteClickHandler as never);
    deleteClickHandler = undefined;
    map.getTargetElement()?.style.setProperty('cursor', '');
  }
}

function activateDrawMode() {
  if (!map) return;
  removeInteractions();

  drawPolygon = new Draw({ source: editSource, type: 'Polygon' });
  modify = new Modify({ source: editSource });
  snap = new Snap({ source: editSource });
  gridSnap = new Snap({ source: gridSnapSource });

  map.addInteraction(modify);
  map.addInteraction(drawPolygon);
  map.addInteraction(snap);
  map.addInteraction(gridSnap);
}

function splitPolygon(splitFeature: Feature) {
  const lineGeom = splitFeature.getGeometry();
  if (!lineGeom || lineGeom.getType() !== 'LineString') return;

  // Write the line as GeoJSON in EPSG:4326 for polygon-clipping
  const lineGeoJSON = format.writeFeatureObject(splitFeature, {
    featureProjection: map!.getView().getProjection(),
  });
  const lineCoords = (lineGeoJSON.geometry as GeoJSONLineString).coordinates;

  // Create a thin polygon from the line (same technique as PoC)
  const thinPoly: [number, number][][] = [
    [
      ...lineCoords.map((c) => [c[0]!, c[1]!] as [number, number]),
      ...lineCoords
        .slice()
        .reverse()
        .map((c) => [c[0]! + 1e-13, c[1]! + 1e-13] as [number, number]),
    ],
  ];

  const featuresToAdd: Feature[] = [];
  const featuresToRemove: Feature[] = [];

  for (const feature of editSource.getFeatures()) {
    const geom = feature.getGeometry();
    if (!geom) continue;
    const type = geom.getType();
    if (type !== 'Polygon' && type !== 'MultiPolygon') continue;

    const featureGeoJSON = format.writeFeatureObject(feature, {
      featureProjection: map!.getView().getProjection(),
    });

    let polyCoords: number[][][][];
    if (featureGeoJSON.geometry.type === 'Polygon') {
      polyCoords = [(featureGeoJSON.geometry as GeoJSONPolygon).coordinates];
    } else {
      polyCoords = (featureGeoJSON.geometry as GeoJSONMultiPolygon).coordinates;
    }

    const result = polygonClipping.difference(
      polyCoords as polygonClipping.MultiPolygon,
      [thinPoly] as unknown as polygonClipping.MultiPolygon,
    );

    if (result.length === 0) continue;

    // Clean up result: round coordinates and remove duplicate/degenerate rings
    for (const poly of result) {
      for (let r = poly.length - 1; r >= 0; r--) {
        const ring = poly[r]!;
        for (let c = ring.length - 1; c >= 0; c--) {
          const point = ring[c]!;
          point[0] = Math.round(point[0] * 1e7) / 1e7;
          point[1] = Math.round(point[1] * 1e7) / 1e7;
          if (c < ring.length - 1 && point[0] === ring[c + 1]![0] && point[1] === ring[c + 1]![1]) {
            ring.splice(c, 1);
          }
        }
        if (ring.length < 4) {
          poly.splice(r, 1);
        }
      }
    }

    // Only process if the split actually produced multiple polygons
    if (result.length <= 1 && polyCoords.length <= 1) {
      // Single polygon result — still update geometry in case edges were trimmed
      if (result.length === 1) {
        const resultFeature = format.readFeature(
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: result[0] } },
          { featureProjection: map!.getView().getProjection() },
        ) as Feature<Polygon>;
        featuresToRemove.push(feature);
        featuresToAdd.push(resultFeature);
      }
      continue;
    }

    // Multiple polygons — create individual features for each
    featuresToRemove.push(feature);
    for (const poly of result) {
      const resultFeature = format.readFeature(
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly } },
        { featureProjection: map!.getView().getProjection() },
      ) as Feature<Polygon>;
      featuresToAdd.push(resultFeature);
    }
  }

  for (const f of featuresToRemove) {
    editSource.removeFeature(f);
  }
  for (const f of featuresToAdd) {
    editSource.addFeature(f);
  }
}

function activateSplitMode() {
  if (!map) return;
  removeInteractions();

  drawLine = new Draw({ source: splitSource, type: 'LineString' });
  snap = new Snap({ source: editSource });
  gridSnap = new Snap({ source: gridSnapSource });

  drawLine.on('drawend', (event) => {
    splitPolygon(event.feature);
    // Clear the split line after clipping
    setTimeout(() => splitSource.clear(), 0);
  });

  map.addInteraction(drawLine);
  map.addInteraction(snap);
  map.addInteraction(gridSnap);
}

function activateDeleteMode() {
  if (!map) return;
  removeInteractions();

  map.getTargetElement()?.style.setProperty('cursor', 'pointer');

  deleteClickHandler = (event: MapBrowserEvent<PointerEvent>) => {
    const feature = map!.forEachFeatureAtPixel(event.pixel, (f) => f, {
      layerFilter: (layer) => layer === editLayer,
    });
    if (feature) {
      editSource.removeFeature(feature as Feature);
    }
  };
  map.on('singleclick', deleteClickHandler as never);
}

watch(editMode, (mode) => {
  if (!map) return;
  if (mode === 'draw') {
    activateDrawMode();
  } else if (mode === 'split') {
    activateSplitMode();
  } else if (mode === 'delete') {
    activateDeleteMode();
  } else {
    removeInteractions();
  }
});

export function initEdit(mapInstance: Map) {
  map = mapInstance;
  map.addLayer(editLayer);
  map.addLayer(splitLayer);
}

export function useEdit() {
  return {
    editMode,
    editSource,
    gridSnapSource,
  };
}
