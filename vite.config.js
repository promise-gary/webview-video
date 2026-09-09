import { defineConfig } from "vite";

const inlinePlayerAssets = () => ({
  name: "inline-player-assets",
  enforce: "post",
  generateBundle(_options, bundle) {
    const htmlAsset = bundle["index.html"];
    const scriptChunk = bundle["assets/player.js"];
    const styleAsset = bundle["assets/player.css"];

    if (htmlAsset?.type !== "asset" || scriptChunk?.type !== "chunk") {
      throw new Error("无法找到需要内联的 HTML 或 JavaScript 产物。");
    }
    if (styleAsset?.type !== "asset") {
      throw new Error("无法找到需要内联的 CSS 产物。");
    }

    const scriptTag = '<script type="module" crossorigin src="./assets/player.js"></script>';
    const styleTag = '<link rel="stylesheet" crossorigin href="./assets/player.css">';
    const script = scriptChunk.code.replaceAll("</script", "<\\/script");
    const style = String(styleAsset.source).replaceAll("</style", "<\\/style");
    const html = String(htmlAsset.source);

    if (!html.includes(scriptTag) || !html.includes(styleTag)) {
      throw new Error("HTML 中的 JavaScript 或 CSS 引用与预期不一致。");
    }

    htmlAsset.source = html
      .replace(scriptTag, `<script type="module">${script}</script>`)
      .replace(styleTag, `<style>${style}</style>`);

    delete bundle["assets/player.js"];
    delete bundle["assets/player.css"];
  },
});

export default defineConfig({
  plugins: [inlinePlayerAssets()],
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
