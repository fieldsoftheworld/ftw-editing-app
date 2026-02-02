<script setup lang="ts">
import { useMap } from '@/composables/useMap';
import { onBeforeUnmount, onMounted, ref } from 'vue';

const { map } = useMap();

const mapContainer = ref<HTMLElement | null>();

let disableAreaSelection: () => void;
onMounted(() => {
  map.setTarget(mapContainer.value!);
});

onBeforeUnmount(() => {
  map.setTarget(undefined);
});
</script>

<template>
  <div ref="mapContainer" class="h-100 w-100"></div>
</template>
