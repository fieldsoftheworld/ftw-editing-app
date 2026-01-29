<script setup lang="ts">
import { mdiInformation } from '@mdi/js';
</script>

<template>
  <div class="header-container position-absolute top-0 w-100 d-flex justify-center">
    <v-expansion-panels class="pointer-events-auto panel-width" flat bg-color="transparent">
      <v-expansion-panel class="rounded-b rounded-t-0" bg-color="rgba(0, 0, 0, 0.75)">
        <v-expansion-panel-title class="pt-0 pb-0" :expand-icon="mdiInformation">
          <span class="text-h6 mr-4 text-no-wrap">Fields of The World: Editor</span>
        </v-expansion-panel-title>

        <v-expansion-panel-text>
          This editor allows for the verification and adjustment of AI-detected agricultural field
          boundaries.
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<style scoped>
.header-container {
  z-index: 2;
  pointer-events: none;
}

.pointer-events-auto {
  pointer-events: auto;
}

.panel-width {
  width: min-content;
}
</style>
