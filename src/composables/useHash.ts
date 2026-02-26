import { watch } from 'vue';
import type Map from 'ol/Map';
import { useGrid } from './useGrid';

let map: Map;
let suppressWatcher = false;

const { selectedGridCellId, selectGridCellById } = useGrid();

function parseHash(): string | undefined {
  const hash = window.location.hash.replace('#', '');
  return hash || undefined;
}

function pushState() {
  if (!map || suppressWatcher) return;
  const gridCellId = selectedGridCellId.value;
  const hash = gridCellId ? '#' + gridCellId : '#';
  if (hash !== window.location.hash) {
    history.pushState(null, '', hash);
  }
}

function restoreState(gridCellId: string | undefined) {
  if (!map) return;
  if (gridCellId === selectedGridCellId.value) return;

  suppressWatcher = true;
  selectGridCellById(gridCellId);
  queueMicrotask(() => {
    suppressWatcher = false;
  });
}

export function initHash(mapInstance: Map) {
  map = mapInstance;

  const gridCellId = parseHash();

  // Push a history entry when grid cell selection changes
  watch(selectedGridCellId, () => {
    if (!suppressWatcher) {
      pushState();
    }
  });

  // Restore state on browser back/forward
  window.addEventListener('popstate', () => {
    restoreState(parseHash());
  });

  // Return the grid cell ID from the hash for deferred selection
  return { gridCellId };
}
