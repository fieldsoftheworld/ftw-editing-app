<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  mdiContentCut,
  mdiDeleteOutline,
  mdiDownload,
  mdiDrawPen,
  mdiFileUploadOutline,
  mdiUndo,
  mdiVectorLine,
  mdiVectorPolygon,
  mdiVectorUnion,
} from '@mdi/js';
import { useGrid } from '@/composables/useGrid';
import { useEdit } from '@/composables/useEdit';
import { OUTCOME_COLORS, useTriage } from '@/composables/useTriage';
import { OUTCOMES } from '@/triage/shapeTriage';

const { gridVisible, selectedGridCellId } = useGrid();
const { editMode, importGeoJSON, exportGeoJSON, canUndo, undo } = useEdit();
const { triageEnabled, triageRunning, counts, flagged, zoomToField, repairField, deleteField } =
  useTriage();

function fieldLabel(feature: { get(key: string): unknown; getId(): unknown }) {
  const id = feature.get('id') ?? feature.getId();
  return id === undefined || id === null ? '' : `${id} · `;
}

const panel = ref<string[]>([]);
const sourceChosen = ref(false);

watch(
  selectedGridCellId,
  (newVal) => {
    if (newVal) {
      panel.value = ['edit'];
    } else if (sourceChosen.value) {
      panel.value = ['area-selection'];
    } else {
      panel.value = ['source'];
    }
  },
  { immediate: true },
);

watch(panel, (val) => {
  if (!val.includes('edit')) {
    editMode.value = null;
  }
});

function setMode(mode: 'draw' | 'split' | 'delete' | 'merge') {
  editMode.value = editMode.value === mode ? null : mode;
}

function chooseFromScratch() {
  sourceChosen.value = true;
  panel.value = ['area-selection'];
}

function openFilePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.geojson,.json,application/geo+json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const geojson = JSON.parse(reader.result as string);
        importGeoJSON(geojson);
        sourceChosen.value = true;
        panel.value = ['area-selection'];
      } catch {
        // TODO: show error notification
      }
    };
    reader.readAsText(file);
  });
  input.click();
}
</script>

<template>
  <div class="wizard-container d-flex flex-column pl-3">
    <v-expansion-panels v-model="panel" class="pointer-events-auto" bg-color="transparent">
      <v-expansion-panel value="source" bg-color="rgba(0, 0, 0, 0.75)">
        <v-expansion-panel-title>Source</v-expansion-panel-title>
        <v-expansion-panel-text>
          <div class="d-flex flex-column ga-2">
            <v-btn :prepend-icon="mdiFileUploadOutline" variant="outlined" @click="openFilePicker">
              Import from model run
            </v-btn>
            <v-btn :prepend-icon="mdiDrawPen" variant="outlined" @click="chooseFromScratch">
              Start from scratch
            </v-btn>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>

      <v-expansion-panel value="area-selection" bg-color="rgba(0, 0, 0, 0.75)">
        <v-expansion-panel-title>Area</v-expansion-panel-title>
        <v-expansion-panel-text v-if="!gridVisible">
          Zoom in or click on the map to see the area grid
        </v-expansion-panel-text>
        <v-expansion-panel-text v-if="gridVisible">
          Click on a grid cell to {{ selectedGridCellId ? 'change selection' : 'start editing' }}
        </v-expansion-panel-text>
      </v-expansion-panel>

      <v-expansion-panel value="edit" bg-color="rgba(0, 0, 0, 0.75)">
        <v-expansion-panel-title>Edit</v-expansion-panel-title>
        <v-expansion-panel-text v-if="!selectedGridCellId">
          Select an area first
        </v-expansion-panel-text>
        <v-expansion-panel-text v-else>
          Draw the outlines of field boundaries, then split them into individual fields.
          <div class="d-flex justify-space-evenly mt-4">
            <v-tooltip text="Draw/modify field boundaries" location="bottom">
              <template v-slot:activator="{ props }">
                <v-btn
                  :icon="mdiVectorPolygon"
                  v-bind="props"
                  :color="editMode === 'draw' ? 'primary' : undefined"
                  :variant="editMode === 'draw' ? 'flat' : 'elevated'"
                  @click="setMode('draw')"
                />
              </template>
            </v-tooltip>
            <v-tooltip
              text="Split fields (draw a line, or click a suggested cut)"
              location="bottom"
            >
              <template v-slot:activator="{ props }">
                <v-btn
                  :icon="mdiVectorLine"
                  v-bind="props"
                  :color="editMode === 'split' ? 'primary' : undefined"
                  :variant="editMode === 'split' ? 'flat' : 'elevated'"
                  @click="setMode('split')"
                />
              </template>
            </v-tooltip>
            <v-tooltip text="Delete field" location="bottom">
              <template v-slot:activator="{ props }">
                <v-btn
                  :icon="mdiDeleteOutline"
                  v-bind="props"
                  :color="editMode === 'delete' ? 'error' : undefined"
                  :variant="editMode === 'delete' ? 'flat' : 'elevated'"
                  @click="setMode('delete')"
                />
              </template>
            </v-tooltip>
            <v-tooltip text="Merge fields" location="bottom">
              <template v-slot:activator="{ props }">
                <v-btn
                  :icon="mdiVectorUnion"
                  v-bind="props"
                  :color="editMode === 'merge' ? 'warning' : undefined"
                  :variant="editMode === 'merge' ? 'flat' : 'elevated'"
                  @click="setMode('merge')"
                />
              </template>
            </v-tooltip>
            <v-tooltip text="Undo" location="bottom">
              <template v-slot:activator="{ props }">
                <v-btn
                  :icon="mdiUndo"
                  v-bind="props"
                  :disabled="!canUndo"
                  variant="elevated"
                  @click="undo()"
                />
              </template>
            </v-tooltip>
          </div>
          <div class="mt-4">
            <v-switch
              v-model="triageEnabled"
              label="Shape checks"
              color="primary"
              density="compact"
              hide-details
            />
            <template v-if="triageEnabled">
              <v-progress-linear v-if="triageRunning" indeterminate color="primary" class="mb-2" />
              <div class="d-flex flex-wrap ga-1">
                <v-chip
                  v-for="outcome in OUTCOMES"
                  :key="outcome"
                  :color="OUTCOME_COLORS[outcome]"
                  size="small"
                  variant="tonal"
                >
                  {{ outcome }}: {{ counts[outcome] }}
                </v-chip>
              </div>
              <v-list
                v-if="flagged.length"
                density="compact"
                bg-color="transparent"
                class="flagged-list mt-2"
              >
                <v-list-item
                  v-for="item in flagged"
                  :key="item.id"
                  :title="fieldLabel(item.feature) + item.result.outcome"
                  :subtitle="item.result.reason"
                  @click="zoomToField(item.feature)"
                >
                  <template v-slot:prepend>
                    <div
                      class="outcome-dot mr-3"
                      :style="{ background: OUTCOME_COLORS[item.result.outcome] }"
                    />
                  </template>
                  <template v-if="item.result.outcome === 'exclude'" v-slot:append>
                    <v-tooltip text="Delete this field (undo restores it)" location="right">
                      <template v-slot:activator="{ props }">
                        <v-btn
                          v-bind="props"
                          :icon="mdiDeleteOutline"
                          aria-label="Delete"
                          size="small"
                          variant="tonal"
                          color="error"
                          @click.stop="deleteField(item.feature)"
                        />
                      </template>
                    </v-tooltip>
                  </template>
                  <template v-else-if="item.result.cuts.length" v-slot:append>
                    <v-tooltip text="Show the suggested cuts with the split tool" location="right">
                      <template v-slot:activator="{ props }">
                        <v-btn
                          v-bind="props"
                          :icon="mdiContentCut"
                          aria-label="Split"
                          size="small"
                          variant="tonal"
                          @click.stop="repairField()"
                        />
                      </template>
                    </v-tooltip>
                  </template>
                </v-list-item>
              </v-list>
              <div class="text-caption text-medium-emphasis mt-2">
                Exploratory proposals, not confirmed errors. Dashed magenta lines are suggested
                cuts: with the split tool, click one to split along it. After each split, the
                resulting fields are checked again.
              </div>
            </template>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>

      <v-expansion-panel value="export" bg-color="rgba(0, 0, 0, 0.75)">
        <v-expansion-panel-title>Export</v-expansion-panel-title>
        <v-expansion-panel-text v-if="!selectedGridCellId">
          Select an area and edit fields first
        </v-expansion-panel-text>
        <v-expansion-panel-text v-else>
          Download the edited fields for the selected grid cell as GeoJSON.
          <div class="d-flex justify-center mt-4">
            <v-btn
              :prepend-icon="mdiDownload"
              color="success"
              variant="flat"
              @click="exportGeoJSON(selectedGridCellId!)"
            >
              Download GeoJSON
            </v-btn>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<style scoped>
.wizard-container {
  position: absolute;
  top: 60px;
  left: 0;
  z-index: 1;
  pointer-events: none;
  max-height: calc(100% - 90px);
  width: 320px;
}

.pointer-events-auto {
  pointer-events: auto;
}

.flagged-list {
  max-height: 240px;
  overflow-y: auto;
}

.flagged-list :deep(.v-list-item-subtitle) {
  white-space: normal;
  -webkit-line-clamp: unset;
  line-clamp: unset;
}

.outcome-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

:deep(.v-expansion-panels) {
  overflow-y: auto;
}
</style>
