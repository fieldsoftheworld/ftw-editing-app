import { computed, ref, shallowRef, watch } from 'vue';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Feature } from 'ol';
import { LineString } from 'ol/geom';
import type Polygon from 'ol/geom/Polygon';
import type MultiPolygon from 'ol/geom/MultiPolygon';
import { Fill, Stroke, Style } from 'ol/style';
import type { StyleLike } from 'ol/style/Style';
import type { FeatureLike } from 'ol/Feature';
import type Map from 'ol/Map';
import type MapBrowserEvent from 'ol/MapBrowserEvent';
import Interaction from 'ol/interaction/Interaction';
import { getUid } from 'ol/util';
import { useEdit } from './useEdit';
import {
  intersectsWindow,
  triageField,
  type CutProposal,
  type Outcome,
  type TriageResult,
} from '@/triage/shapeTriage';

const {
  editMode,
  editLayer,
  editSource,
  gridSnapSource,
  splitFeatureInto,
  saveSnapshot,
  registerSplitModeInteraction,
  isSplitSketching,
  getSplitParent,
} = useEdit();

export const OUTCOME_COLORS: Record<Outcome, string> = {
  exclude: '#ff5252',
  repair: '#ff9100',
  abstain: '#ffd600',
  retain: '#00c8ff',
};

export interface FlaggedField {
  id: string;
  feature: Feature;
  result: TriageResult;
}

const triageEnabled = ref(true);
const triageRunning = ref(false);
const triaged = shallowRef<FlaggedField[]>([]);

const counts = computed(() => {
  const c: Record<Outcome, number> = { exclude: 0, repair: 0, abstain: 0, retain: 0 };
  for (const { result } of triaged.value) c[result.outcome]++;
  return c;
});
const order: Record<Outcome, number> = { exclude: 0, repair: 1, abstain: 2, retain: 3 };
const flagged = computed(() =>
  triaged.value
    .filter(({ result }) => result.outcome !== 'retain')
    .sort((a, b) => order[a.result.outcome] - order[b.result.outcome]),
);

// Cache keyed by feature, invalidated by geometry revision.
const cache = new WeakMap<Feature, { revision: number; result: TriageResult }>();
// Features in the selected grid cell, i.e. the ones that get triage styling.
let inCell = new WeakSet<Feature>();

const cutSource = new VectorSource();
const cutLayer = new VectorLayer({
  source: cutSource,
  zIndex: 10,
  style: [
    new Style({ stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.8)', width: 6 }) }),
    new Style({ stroke: new Stroke({ color: '#ff40ff', width: 3, lineDash: [6, 4] }) }),
  ],
});

function outcomeStyles(outcome: Outcome): Style[] {
  const color = OUTCOME_COLORS[outcome];
  return [
    new Style({ stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.7)', width: 4 }), zIndex: 0 }),
    new Style({
      fill: new Fill({ color: `${color}33` }),
      stroke: new Stroke({ color, width: 2 }),
      zIndex: 1,
    }),
  ];
}
const styles = {
  exclude: outcomeStyles('exclude'),
  repair: outcomeStyles('repair'),
  abstain: outcomeStyles('abstain'),
};

let map: Map | undefined;
let defaultStyle: StyleLike | undefined;

function triageStyle(feature: FeatureLike, resolution: number) {
  const entry =
    triageEnabled.value && inCell.has(feature as Feature)
      ? cache.get(feature as Feature)
      : undefined;
  const geom = (feature as Feature).getGeometry();
  if (entry && geom && entry.revision === geom.getRevision()) {
    const outcome = entry.result.outcome;
    if (outcome !== 'retain') return styles[outcome];
  }
  return typeof defaultStyle === 'function' ? defaultStyle(feature, resolution) : defaultStyle;
}

// ---- Scheduling: debounced, time-sliced, cancellable ----

let debounce: ReturnType<typeof setTimeout> | undefined;
let runToken = 0;

function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(run, 300);
}

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

async function run() {
  const token = ++runToken;
  const cell = gridSnapSource.getFeatures()[0]?.getGeometry() as Polygon | undefined;
  if (!triageEnabled.value || !cell) {
    inCell = new WeakSet();
    triaged.value = [];
    cutSource.clear();
    triageRunning.value = false;
    editLayer.changed();
    return;
  }
  triageRunning.value = true;
  const candidates = editSource.getFeaturesInExtent(cell.getExtent());
  const results: FlaggedField[] = [];
  const nextInCell = new WeakSet<Feature>();
  let sliceStart = performance.now();
  for (const feature of candidates) {
    const geom = feature.getGeometry();
    if (!geom || (geom.getType() !== 'Polygon' && geom.getType() !== 'MultiPolygon')) continue;
    const polygonal = geom as Polygon | MultiPolygon;
    if (!intersectsWindow(polygonal, cell)) continue;
    const revision = geom.getRevision();
    let entry = cache.get(feature);
    if (!entry || entry.revision !== revision) {
      // A field created by a split carries over its parent's remaining cuts.
      const parent = getSplitParent(feature);
      const inherited = parent ? (cache.get(parent)?.result.cuts.map((c) => c.line) ?? []) : [];
      entry = { revision, result: triageField(polygonal, inherited) };
      cache.set(feature, entry);
    }
    nextInCell.add(feature);
    results.push({ id: getUid(feature), feature, result: entry.result });
    if (performance.now() - sliceStart > 30) {
      await yieldToBrowser();
      if (token !== runToken) return;
      sliceStart = performance.now();
    }
  }
  if (token !== runToken) return;
  inCell = nextInCell;
  triaged.value = results;
  updateCuts();
  editLayer.changed();
  triageRunning.value = false;
}

function updateCuts() {
  cutSource.clear();
  const features: Feature[] = [];
  for (const { feature, result } of triaged.value) {
    for (const cut of result.cuts) {
      const cutFeature = new Feature(new LineString(cut.line));
      cutFeature.set('parent', feature);
      cutFeature.set('cut', cut);
      features.push(cutFeature);
    }
  }
  cutSource.addFeatures(features);
}

// ---- One-click suggested cuts in split mode ----

function cutAtPixel(pixel: number[]): Feature | undefined {
  if (!map || !cutLayer.getVisible()) return undefined;
  return map.forEachFeatureAtPixel(pixel, (f) => f as Feature, {
    layerFilter: (layer) => layer === cutLayer,
    hitTolerance: 6,
  });
}

/**
 * Split-mode interaction: a click on a suggested cut line splits that field along
 * it with the split tool. Anywhere else, and while a split line is being drawn,
 * events pass through to the split tool's draw interaction unchanged.
 */
let downOnCut: { feature: Feature; pixel: number[] } | undefined;
const cutPicker = new Interaction({
  handleEvent(event: MapBrowserEvent) {
    if (isSplitSketching()) return true;
    if (event.type === 'pointermove') {
      const hit = !event.dragging && cutAtPixel(event.pixel);
      map?.getTargetElement()?.style.setProperty('cursor', hit ? 'pointer' : '');
      return true;
    }
    if (event.type === 'pointerdown') {
      const feature = cutAtPixel(event.pixel);
      downOnCut = feature ? { feature, pixel: event.pixel } : undefined;
      // Swallow it, so the draw interaction does not start a split line here.
      return !feature;
    }
    if (event.type === 'pointerup' && downOnCut) {
      const { feature, pixel } = downOnCut;
      downOnCut = undefined;
      const moved = Math.hypot(event.pixel[0]! - pixel[0]!, event.pixel[1]! - pixel[1]!);
      if (moved < 6) {
        // Apply the exact, validated parts of the cut (not a re-split of the line).
        splitFeatureInto(
          feature.get('parent') as Feature,
          (feature.get('cut') as CutProposal).parts,
        );
      }
      return false;
    }
    return true;
  },
});
registerSplitModeInteraction(cutPicker);

/** Delete a field (e.g. one flagged for exclusion), undoably. */
function deleteField(feature: Feature) {
  if (!editSource.hasFeature(feature)) return;
  saveSnapshot();
  editSource.removeFeature(feature);
}

/** Switch to the split tool, where suggested cuts can be applied with one click. */
function repairField() {
  editMode.value = 'split';
}

watch(triageEnabled, (enabled) => {
  cutLayer.setVisible(enabled);
  schedule();
});

function zoomToField(feature: Feature) {
  const geom = feature.getGeometry();
  if (!map || !geom) return;
  const size = map.getSize() ?? [0, 0];
  map.getView().fit(geom.getExtent(), {
    padding:
      size[1]! > 0 ? [size[1]! * 0.3, size[0]! * 0.3, size[1]! * 0.3, size[0]! * 0.3] : undefined,
    maxZoom: 18,
    duration: 500,
  });
}

export function initTriage(mapInstance: Map) {
  map = mapInstance;
  defaultStyle = (editLayer.getStyle() ?? undefined) as StyleLike | undefined;
  editLayer.setStyle(triageStyle);
  map.addLayer(cutLayer);
  // Drop a split field's suggested cuts right away rather than after re-triage.
  editSource.on('removefeature', (event) => {
    for (const cut of cutSource.getFeatures()) {
      if (cut.get('parent') === event.feature) cutSource.removeFeature(cut);
    }
  });
  for (const type of ['addfeature', 'removefeature', 'changefeature', 'clear'] as const) {
    editSource.on(type, schedule);
    gridSnapSource.on(type, schedule);
  }
  schedule();
}

export function useTriage() {
  return {
    triageEnabled,
    triageRunning,
    counts,
    flagged,
    zoomToField,
    repairField,
    deleteField,
  };
}
