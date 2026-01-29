<script setup lang="ts">
import { useMap } from '@/composables/useMap';
import { onBeforeUnmount, onMounted, ref } from 'vue';

const { map, enableAreaSelection } = useMap();

const mapContainer = ref<HTMLElement | null>();

let disableAreaSelection: () => void;
onMounted(() => {
  map.setTarget(mapContainer.value!);
  disableAreaSelection = enableAreaSelection();
});

onBeforeUnmount(() => {
  map.setTarget(undefined);
  disableAreaSelection();
});
</script>

<template>
  <div ref="mapContainer" class="h-100 w-100"></div>
</template>
