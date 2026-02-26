# Copilot Instructions for ftw-editing-app

This is a **Vue 3** application built with **Vite**, **TypeScript**, **Vuetify**, and **OpenLayers**. The app focuses on map-based editing of AI model generated polygons of agricultural fields.

## 🏗 Project Architecture

### Map Logic (Critical)

- **Singleton Pattern:** The OpenLayers map instance is a **singleton** managed in `src/composables/useMap.ts`.
  - **Do not** create new `new Map()` instances in components.
  - **Always** use `const { map } = useMap()` to access the global map.
  - The map is configured using `ol-mapbox-style` to load a map configuration from a Mapbox/MapLibre style.
- **Component Integration:** `src/components/TheMap.vue` is responsible _only_ for providing the DOM target (`map.setTarget()`). It does not manage map state.

### UI & Styling

- **Vuetify 3:** Configured in `src/plugins/vuetify.ts` and imported in `main.ts`.
- **Styling:**
  - Avoid inline `style="..."` attributes. Use Vuetify utility classes where possible.
  - For custom CSS, use **scoped** styles in `<style scoped>` blocks.
  - Global CSS overrides (e.g. for OpenLayers variables) live in `src/styles.css`.
- **Icons (Important):** This project uses **SVG paths** (`@mdi/js`), NOT font classes.
  - **Incorrect:** `<v-icon>mdi-home</v-icon>`
  - **Correct:**
    ```vue
    <script setup lang="ts">
    import { mdiHome } from '@mdi/js';
    </script>
    <template>
      <v-icon :icon="mdiHome" />
    </template>
    ```

## 🛠 Developer Conventions

### Imports & paths

- Use the `@` alias for `src` (e.g., `import { useMap } from '@/composables/map'`).
- Prefer named imports for Vue compositions and OpenLayers modules to enable tree-shaking.

### TypeScript

- All `.vue` files must use `<script setup lang="ts">`.
- Use `npm run type-check` (which runs `vue-tsc`) to verify types, as Vite's dev server handles only transpilation.

### Linting

- Run `npm run lint` to fix logic and styling issues.
- The project follows Prettier formatting rules (via `eslint-config-prettier`).

## 📁 Key Files

- `src/composables/useMap.ts`: Global map instance and layer configuration.
- `src/components/TheMap.vue`: Main map container component.
- `src/plugins/vuetify.ts`: Theme and icon configuration.
- `vite.config.ts`: Build and alias configuration.
