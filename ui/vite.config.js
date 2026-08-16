import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base "./" so the built bundle works from a GitHub Pages subpath.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
