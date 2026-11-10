import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	clearScreen: false,
	resolve: { tsconfigPaths: true },
	server: { port: 3000, strictPort: true },
	plugins: [
		tanstackStart({
			spa: {
				enabled: true,
				prerender: { outputPath: "/index.html" },
			},
		}),
		tailwindcss(),
		viteReact(),
	],
});
