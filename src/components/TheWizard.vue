<script setup lang="ts">
import { ref } from 'vue';
import { useGrid } from '@/composables/useGrid';

const { gridVisible } = useGrid();

const panel = ref(['area-selection']);
</script>

<template>
  <div class="wizard-container d-flex flex-column pl-3">
    <v-expansion-panels v-model="panel" class="pointer-events-auto" bg-color="transparent">
      <v-expansion-panel value="area-selection" bg-color="rgba(0, 0, 0, 0.75)">
        <v-expansion-panel-title>Area</v-expansion-panel-title>
        <v-expansion-panel-text v-if="!gridVisible">
          Zoom in or click on the map to see the area grid
        </v-expansion-panel-text>
        <v-expansion-panel-text v-else>
          Click on a grid cell to start editing
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
