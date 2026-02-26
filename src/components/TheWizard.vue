<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  mdiDeleteOutline,
  mdiDownload,
  mdiDrawPen,
  mdiFileUploadOutline,
  mdiVectorLine,
  mdiVectorPolygon,
  mdiVectorUnion,
} from '@mdi/js';
import { useGrid } from '@/composables/useGrid';
import { useEdit } from '@/composables/useEdit';

const { gridVisible, selectedGridCellId } = useGrid();
const { editMode, importGeoJSON, exportGeoJSON } = useEdit();

const panel = ref<string[]>([]);
const sourceChosen = ref(false);

watch(
  selectedGridCellId,
  (newVal) => {
    if (newVal) {
      panel.value = ['edit'];
    } else if (sourceChosen.value) {
      panel.value = ['area-selection'];
      editMode.value = null;
    } else {
      panel.value = ['source'];
      editMode.value = null;
    }
  },
  { immediate: true },
);

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
            <v-tooltip text="Split fields" location="bottom">
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

:deep(.v-expansion-panels) {
  overflow-y: auto;
}
</style>
