<script setup lang="ts">
import { mdiRocketLaunchOutline } from '@mdi/js'
</script>

<template>
  <v-app>
    <v-main class="d-flex flex-column align-center justify-center fill-height">
      <h1>You did it!</h1>
      <v-icon :icon="mdiRocketLaunchOutline"></v-icon>
      <p>
        Visit <a href="https://vuejs.org/" target="_blank" rel="noopener">vuejs.org</a> to read the
        documentation
      </p>
    </v-main>
  </v-app>
</template>

<style scoped></style>
