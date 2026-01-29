<script setup lang="ts">
import { ref } from 'vue';

const panel = ref(['area-selection']);
</script>

<template>
  <div class="wizard-container d-flex flex-column pl-3">
    <v-expansion-panels v-model="panel" class="pointer-events-auto" bg-color="transparent">
      <v-expansion-panel value="area-selection" bg-color="rgba(0, 0, 0, 0.75)">
        <v-expansion-panel-title>1. Area selection</v-expansion-panel-title>
        <v-expansion-panel-text> Click on the map to select an area. </v-expansion-panel-text>
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
