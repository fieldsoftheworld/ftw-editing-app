<script setup lang="ts">
import { useMap } from '@/composables/useMap';
import { onMounted, ref } from 'vue';

const { map } = useMap();

const mapContainer = ref<HTMLElement | null>();

onMounted(() => {
  map.setTarget(mapContainer.value!);
});
</script>

<template>
  <div ref="mapContainer" class="h-100 w-100"></div>
</template>
