<script setup lang="ts">
import { ref, watch } from 'vue';
import { mdiVectorLine, mdiVectorPolygon } from '@mdi/js';
import { useGrid } from '@/composables/useGrid';

const { gridVisible, selectedGridCellId } = useGrid();

const panel = ref<string[]>([]);

watch(
  selectedGridCellId,
  (newVal) => {
    if (newVal) {
      panel.value = ['edit'];
    } else {
      panel.value = ['area-selection'];
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="wizard-container d-flex flex-column pl-3">
    <v-expansion-panels v-model="panel" class="pointer-events-auto" bg-color="transparent">
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
            <v-tooltip text="Draw field boundaries" location="bottom">
              <template v-slot:activator="{ props }">
                <v-btn :icon="mdiVectorPolygon" v-bind="props" />
              </template>
            </v-tooltip>
            <v-tooltip text="Split fields" location="bottom">
              <template v-slot:activator="{ props }">
                <v-btn :icon="mdiVectorLine" v-bind="props" />
              </template>
            </v-tooltip>
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
