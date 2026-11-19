import { ref, watch } from 'vue';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import Draw from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Snap from 'ol/interaction/Snap';
import type Interaction from 'ol/interaction/Interaction';
import { Fill, Stroke, Style } from 'ol/style';
import GeoJSON from 'ol/format/GeoJSON';
import type { Polygon as GeoJSONPolygon, MultiPolygon as GeoJSONMultiPolygon } from 'geojson';
import polygonClipping from 'polygon-clipping';
import type { Feature } from 'ol';
import { Feature as OlFeature } from 'ol';
import { Polygon } from 'ol/geom';
import type { LineString, MultiPolygon } from 'ol/geom';
import { splitPolygonByLine } from '@/geometry/splitPolygon';
import type Map from 'ol/Map';
import type MapBrowserEvent from 'ol/MapBrowserEvent';
import { intersects, isEmpty } from 'ol/extent';

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

// Extra interactions active in split mode (e.g. one-click suggested cuts). They are
// added after the draw interaction, so they see map events before it does.
const splitModeInteractions: Interaction[] = [];
let splitSketching = false;

function registerSplitModeInteraction(interaction: Interaction) {
  splitModeInteractions.push(interaction);
}

/** Whether a split line is currently being drawn. */
function isSplitSketching() {
  return splitSketching;
}

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
  for (const interaction of splitModeInteractions) {
    if (map.getInteractions().getArray().includes(interaction)) {
      map.removeInteraction(interaction);
      map.getTargetElement()?.style.setProperty('cursor', '');
    }
  }
  splitSketching = false;
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

/** A feature's properties without its geometry. */
function featureProperties(feature: Feature): Record<string, unknown> {
  const properties = feature.getProperties();
  delete properties[feature.getGeometryName()];
  return properties;
}

// Field each split result came from, e.g. to carry over its suggested cuts.
const splitParents = new WeakMap<Feature, Feature>();

function getSplitParent(feature: Feature): Feature | undefined {
  return splitParents.get(feature);
}

/** Bijective base-26 suffix: 0 -> a, 25 -> z, 26 -> aa, ... */
function idSuffix(index: number): string {
  let suffix = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    suffix = String.fromCharCode(97 + ((n - 1) % 26)) + suffix;
  }
  return suffix;
}

/**
 * Create a feature for a split result, keeping the parent's properties. When the
 * parent was split into several parts, ids get a letter suffix ("3" -> "3a", "3b").
 */
function splitChild(parent: Feature, geometry: Polygon, index?: number): Feature<Polygon> {
  const child = new OlFeature(geometry);
  const properties = featureProperties(parent);
  const suffix = index === undefined ? '' : idSuffix(index);
  if (properties.id !== undefined && properties.id !== null) {
    properties.id = `${properties.id}${suffix}`;
  }
  child.setProperties(properties);
  const id = parent.getId();
  if (id !== undefined) child.setId(`${id}${suffix}`);
  splitParents.set(child, parent);
  return child;
}

/** Order split parts west to east, then north to south, for stable id suffixes. */
function compareParts(a: number[][][], b: number[][][]): number {
  const minX = (p: number[][][]) => Math.min(...p[0]!.map((c) => c[0]!));
  const maxY = (p: number[][][]) => Math.max(...p[0]!.map((c) => c[1]!));
  return minX(a) - minX(b) || maxY(b) - maxY(a);
}

/**
 * Split polygons along a line (in map projection) with an exact JSTS split. With
 * `targets`, only those features are split; otherwise every feature the line
 * splits. Features the line does not split stay unchanged. A split MultiPolygon
 * is replaced by all of its parts.
 */
function splitPolygon(lineGeom: LineString, targets?: Feature[]) {
  const line = lineGeom.getCoordinates();
  const lineExtent = lineGeom.getExtent();

  const featuresToAdd: Feature[] = [];
  const featuresToRemove: Feature[] = [];

  for (const feature of targets ?? editSource.getFeatures()) {
    const geom = feature.getGeometry();
    if (!geom) continue;
    const type = geom.getType();
    if (type !== 'Polygon' && type !== 'MultiPolygon') continue;
    if (!intersects(geom.getExtent(), lineExtent)) continue;

    const polygons =
      type === 'Polygon'
        ? [(geom as Polygon).getCoordinates()]
        : (geom as MultiPolygon).getCoordinates();
    let split = false;
    const parts = polygons.flatMap((rings) => {
      const result = splitPolygonByLine(rings, line);
      if (result) split = true;
      return result ?? [rings];
    });
    if (!split) continue;

    featuresToRemove.push(feature);
    parts
      .sort(compareParts)
      .forEach((rings, i) => featuresToAdd.push(splitChild(feature, new Polygon(rings), i)));
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

  drawLine.on('drawstart', () => (splitSketching = true));
  drawLine.on('drawabort', () => (splitSketching = false));
  drawLine.on('drawend', (event) => {
    splitSketching = false;
    saveSnapshot();
    splitPolygon(event.feature.getGeometry() as LineString);
    // Clear the split line after clipping
    setTimeout(() => splitSource.clear(), 0);
  });

  map.addInteraction(drawLine);
  map.addInteraction(snap);
  map.addInteraction(gridSnap);
  for (const interaction of splitModeInteractions) map.addInteraction(interaction);
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

/**
 * Replace a feature by precomputed parts (polygon ring coordinates in the map
 * projection) that exactly partition it, e.g. a validated suggested cut. Ids and
 * properties are handled as with the split tool.
 */
function splitFeatureInto(feature: Feature, parts: number[][][][]) {
  if (!map || !editSource.hasFeature(feature) || parts.length < 2) return;
  saveSnapshot();
  const children = [...parts]
    .sort(compareParts)
    .map((rings, i) => splitChild(feature, new Polygon(rings), i));
  editSource.removeFeature(feature);
  editSource.addFeatures(children);
}

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

    const properties = featureProperties(feature);
    const id = feature.getId();
    clipped.sort(compareParts).forEach((poly, i) => {
      // Clipping to the grid cell can cut a field into parts: keep ids unique.
      const suffix = clipped.length > 1 ? idSuffix(i) : '';
      exportFeatures.push({
        type: 'Feature',
        ...(id !== undefined ? { id: `${id}${suffix}` } : {}),
        properties:
          properties.id !== undefined && properties.id !== null
            ? { ...properties, id: `${properties.id}${suffix}` }
            : properties,
        geometry: { type: 'Polygon', coordinates: poly },
      });
    });
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
    editLayer,
    editSource,
    gridSnapSource,
    saveSnapshot,
    splitFeatureInto,
    registerSplitModeInteraction,
    getSplitParent,
    isSplitSketching,
    canUndo,
    undo,
    importGeoJSON,
    exportGeoJSON,
  };
}
