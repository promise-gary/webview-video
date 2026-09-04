import { defineConfig } from "vite";

export default defineConfig({
  // 产物可以从任意静态站点根路径加载。
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rolldownOptions: {
      output: {
        // 当前项目只有一个入口且没有动态导入，因此产出一个 JavaScript 文件。
        codeSplitting: false,
        entryFileNames: "assets/player.js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css") === true) {
            return "assets/player.css";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
