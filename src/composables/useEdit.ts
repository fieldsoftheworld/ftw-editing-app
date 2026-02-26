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
import { isEmpty } from 'ol/extent';

export type EditMode = 'draw' | 'split' | 'delete' | 'merge' | null;

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

// Undo stack — stores GeoJSON snapshots of editSource before each action
const undoStack: object[] = [];
const canUndo = ref(false);

function saveSnapshot() {
  if (!map) return;
  const geojson = format.writeFeaturesObject(editSource.getFeatures(), {
    featureProjection: map.getView().getProjection(),
  });
  undoStack.push(geojson);
  canUndo.value = true;
}

function undo() {
  if (!map || undoStack.length === 0) return;
  const geojson = undoStack.pop()!;
  canUndo.value = undoStack.length > 0;
  editSource.clear();
  const features = format.readFeatures(geojson, {
    featureProjection: map.getView().getProjection(),
  });
  editSource.addFeatures(features);
}

let map: Map | undefined;
let drawPolygon: Draw | undefined;
let drawLine: Draw | undefined;
let modify: Modify | undefined;
let snap: Snap | undefined;
let gridSnap: Snap | undefined;
let deleteClickHandler: ((event: MapBrowserEvent<PointerEvent>) => void) | undefined;
let mergeClickHandler: ((event: MapBrowserEvent<PointerEvent>) => void) | undefined;
let mergeTarget: Feature | undefined;

const mergeHighlightStyle = [
  new Style({
    stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.7)', width: 4 }),
    zIndex: 0,
  }),
  new Style({
    fill: new Fill({ color: 'rgba(255, 165, 0, 0.25)' }),
    stroke: new Stroke({ color: 'rgba(255, 165, 0, 1)', width: 2 }),
    zIndex: 1,
  }),
];

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
  if (mergeClickHandler) {
    map.un('singleclick', mergeClickHandler as never);
    mergeClickHandler = undefined;
    if (mergeTarget) {
      mergeTarget.setStyle(undefined);
      mergeTarget = undefined;
    }
    map.getTargetElement()?.style.setProperty('cursor', '');
  }
}

function activateDrawMode() {
  if (!map) return;
  removeInteractions();

  drawPolygon = new Draw({ source: editSource, type: 'Polygon', trace: true });
  modify = new Modify({ source: editSource });
  snap = new Snap({ source: editSource });
  gridSnap = new Snap({ source: gridSnapSource });

  drawPolygon.on('drawend', () => saveSnapshot());
  modify.on('modifystart', () => saveSnapshot());

  map.addInteraction(modify);
  map.addInteraction(drawPolygon);
  map.addInteraction(snap);
  map.addInteraction(gridSnap);
}

/**
 * Create a buffer polygon around a line by unioning per-segment rectangles.
 * Robust against sharp turns (no miter issues) and duplicate vertices.
 */
function bufferLine(
  lineCoords: number[][],
  distance: number,
): polygonClipping.MultiPolygon | undefined {
  // Remove consecutive duplicate vertices
  const coords: number[][] = [lineCoords[0]!];
  for (let i = 1; i < lineCoords.length; i++) {
    const prev = coords[coords.length - 1]!;
    const curr = lineCoords[i]!;
    if (curr[0] !== prev[0] || curr[1] !== prev[1]) {
      coords.push(curr);
    }
  }
  if (coords.length < 2) return undefined;

  // Create a rectangle for each segment
  const rectangles: polygonClipping.Polygon[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const x1 = coords[i]![0]!;
    const y1 = coords[i]![1]!;
    const x2 = coords[i + 1]![0]!;
    const y2 = coords[i + 1]![1]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;
    const nx = (-dy / len) * distance;
    const ny = (dx / len) * distance;
    // Extend the rectangle by half the buffer width along the segment direction
    const ex = (dx / len) * distance;
    const ey = (dy / len) * distance;
    const rect: polygonClipping.Polygon = [
      [
        [x1 - ex + nx, y1 - ey + ny],
        [x2 + ex + nx, y2 + ey + ny],
        [x2 + ex - nx, y2 + ey - ny],
        [x1 - ex - nx, y1 - ey - ny],
        [x1 - ex + nx, y1 - ey + ny],
      ],
    ];
    rectangles.push(rect);
  }

  if (rectangles.length === 0) return undefined;
  if (rectangles.length === 1) return [rectangles[0]!];
  return polygonClipping.union(rectangles[0]!, ...rectangles.slice(1));
}

/**
 * Snap a point to the nearest position on a polyline if within threshold.
 * Modifies the point in place so that vertices on both sides of the split
 * gap collapse to the exact same coordinates on the split line.
 */
function snapToLine(point: number[], lineCoords: number[][], thresholdSq: number): void {
  let minDistSq = Infinity;
  let closestX = 0;
  let closestY = 0;

  for (let i = 0; i < lineCoords.length - 1; i++) {
    const x1 = lineCoords[i]![0]!;
    const y1 = lineCoords[i]![1]!;
    const x2 = lineCoords[i + 1]![0]!;
    const y2 = lineCoords[i + 1]![1]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((point[0]! - x1) * dx + (point[1]! - y1) * dy) / lenSq));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const distSq = (point[0]! - px) ** 2 + (point[1]! - py) ** 2;
    if (distSq < minDistSq) {
      minDistSq = distSq;
      closestX = px;
      closestY = py;
    }
  }

  if (minDistSq <= thresholdSq) {
    point[0] = closestX;
    point[1] = closestY;
  }
}

function splitPolygon(splitFeature: Feature) {
  const lineGeom = splitFeature.getGeometry();
  if (!lineGeom || lineGeom.getType() !== 'LineString') return;

  // Write the line as GeoJSON in EPSG:4326 for polygon-clipping
  const lineGeoJSON = format.writeFeatureObject(splitFeature, {
    featureProjection: map!.getView().getProjection(),
  });
  const lineCoords = (lineGeoJSON.geometry as GeoJSONLineString).coordinates;

  // Create a thin buffer polygon around the line
  const bufferDistance = 1e-8;
  const bufferPoly = bufferLine(lineCoords, bufferDistance);
  if (!bufferPoly) return;
  const snapThresholdSq = (bufferDistance * 3) ** 2;

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
      bufferPoly,
    );

    if (result.length === 0) continue;

    // Snap vertices near the split line back onto it to collapse the buffer gap,
    // so result polygons share exact boundary vertices along the split.
    for (const poly of result) {
      for (let r = poly.length - 1; r >= 0; r--) {
        const ring = poly[r]!;
        for (const point of ring) {
          snapToLine(point, lineCoords, snapThresholdSq);
        }
        // Remove consecutive duplicate vertices
        for (let c = ring.length - 1; c > 0; c--) {
          if (ring[c]![0] === ring[c - 1]![0] && ring[c]![1] === ring[c - 1]![1]) {
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
    saveSnapshot();
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
      saveSnapshot();
      editSource.removeFeature(feature as Feature);
    }
  };
  map.on('singleclick', deleteClickHandler as never);
}

function mergeFeatures(target: Feature, source: Feature): Feature | undefined {
  const projection = map!.getView().getProjection();
  const targetGeoJSON = format.writeFeatureObject(target, { featureProjection: projection });
  const sourceGeoJSON = format.writeFeatureObject(source, { featureProjection: projection });

  const getCoords = (gj: typeof targetGeoJSON): number[][][][] => {
    if (gj.geometry.type === 'Polygon') {
      return [(gj.geometry as GeoJSONPolygon).coordinates];
    }
    return (gj.geometry as GeoJSONMultiPolygon).coordinates;
  };

  const result = polygonClipping.union(
    getCoords(targetGeoJSON) as polygonClipping.MultiPolygon,
    getCoords(sourceGeoJSON) as polygonClipping.MultiPolygon,
  );

  if (result.length === 0) return undefined;

  const geomType = result.length === 1 ? 'Polygon' : 'MultiPolygon';
  const coordinates = result.length === 1 ? result[0] : result;
  return format.readFeature(
    { type: 'Feature', geometry: { type: geomType, coordinates } },
    { featureProjection: projection },
  ) as Feature;
}

function activateMergeMode() {
  if (!map) return;
  removeInteractions();

  map.getTargetElement()?.style.setProperty('cursor', 'pointer');

  mergeClickHandler = (event: MapBrowserEvent<PointerEvent>) => {
    const feature = map!.forEachFeatureAtPixel(event.pixel, (f) => f, {
      layerFilter: (layer) => layer === editLayer,
    }) as Feature | undefined;
    if (!feature) return;

    if (!mergeTarget) {
      // First click — highlight as merge target
      mergeTarget = feature;
      mergeTarget.setStyle(mergeHighlightStyle);
      return;
    }

    if (feature === mergeTarget) return;

    // Second click — merge with target
    const merged = mergeFeatures(mergeTarget, feature);
    if (merged) {
      saveSnapshot();
      editSource.removeFeature(mergeTarget);
      editSource.removeFeature(feature);
      editSource.addFeature(merged);
      // Highlight the merged result as the new target
      mergeTarget = merged;
      mergeTarget.setStyle(mergeHighlightStyle);
    }
  };
  map.on('singleclick', mergeClickHandler as never);
}

watch(editMode, (mode) => {
  if (!map) return;
  if (mode === 'draw') {
    activateDrawMode();
  } else if (mode === 'split') {
    activateSplitMode();
  } else if (mode === 'delete') {
    activateDeleteMode();
  } else if (mode === 'merge') {
    activateMergeMode();
  } else {
    removeInteractions();
  }
});

export function initEdit(mapInstance: Map) {
  map = mapInstance;
  map.addLayer(editLayer);
  map.addLayer(splitLayer);
}

function importGeoJSON(geojson: object) {
  if (!map) return;
  saveSnapshot();
  const features = format.readFeatures(geojson, {
    featureProjection: map.getView().getProjection(),
  });
  editSource.addFeatures(features);
  const extent = editSource.getExtent();
  if (extent && !isEmpty(extent)) {
    const size = map.getSize();
    const width = size?.[0] ?? 0;
    const height = size?.[1] ?? 0;
    map.getView().fit(extent, {
      padding: [height * 0.125, width * 0.125, height * 0.125, width * 0.125],
      duration: 500,
    });
  }
}

function exportGeoJSON(gridCellId: string) {
  if (!map) return;
  const projection = map.getView().getProjection();

  // Get the grid cell geometry for clipping
  const gridFeature = gridSnapSource.getFeatures()[0];
  if (!gridFeature) return;
  const gridGeoJSON = format.writeFeatureObject(gridFeature, { featureProjection: projection });
  const gridCoords = (gridGeoJSON.geometry as GeoJSONPolygon).coordinates;

  const exportFeatures: object[] = [];

  for (const feature of editSource.getFeatures()) {
    const geom = feature.getGeometry();
    if (!geom) continue;
    const type = geom.getType();
    if (type !== 'Polygon' && type !== 'MultiPolygon') continue;

    const featureGeoJSON = format.writeFeatureObject(feature, { featureProjection: projection });
    let polyCoords: number[][][][];
    if (featureGeoJSON.geometry.type === 'Polygon') {
      polyCoords = [(featureGeoJSON.geometry as GeoJSONPolygon).coordinates];
    } else {
      polyCoords = (featureGeoJSON.geometry as GeoJSONMultiPolygon).coordinates;
    }

    const clipped = polygonClipping.intersection(
      polyCoords as polygonClipping.MultiPolygon,
      [gridCoords] as unknown as polygonClipping.MultiPolygon,
    );

    if (clipped.length === 0) continue;

    for (const poly of clipped) {
      exportFeatures.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: poly },
      });
    }
  }

  const geojson = {
    type: 'FeatureCollection',
    features: exportFeatures,
  };

  const blob = new Blob([JSON.stringify(geojson)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fields-${gridCellId}.geojson`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useEdit() {
  return {
    editMode,
    editSource,
    gridSnapSource,
    canUndo,
    undo,
    importGeoJSON,
    exportGeoJSON,
  };
}
