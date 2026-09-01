import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ENTRY_MODULE = 'src/index.js';
const OUTPUT_FILE = 'dist/player-bundle.js';
const IMPORT_PATTERN = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];\s*$/gm;
const EXPORT_CLASS_PATTERN = /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g;

/** 将项目内的 ES Modules 打包成 WebView 可直接加载的单文件脚本。 */
class PlayerBundler {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.modules = new Map();
  }

  build() {
    this._collect(ENTRY_MODULE);
    const factories = [...this.modules.entries()]
      .map(([moduleId, moduleSource]) => this._createFactory(moduleId, moduleSource))
      .join(',\n');
    const output = `/* 此文件由 npm run build 自动生成，请勿直接修改。 */
(() => {
  'use strict';

  const moduleFactories = {
${factories}
  };
  const moduleCache = new Map();

  const loadModule = (moduleId) => {
    if (moduleCache.has(moduleId)) return moduleCache.get(moduleId).exports;
    const factory = moduleFactories[moduleId];
    if (!factory) throw new Error(\`找不到播放器模块：\${moduleId}\`);

    const module = { exports: {} };
    moduleCache.set(moduleId, module);
    factory(module, module.exports, loadModule);
    return module.exports;
  };

  loadModule(${JSON.stringify(ENTRY_MODULE)});
})();
`;
    writeFileSync(path.join(this.rootDirectory, OUTPUT_FILE), output);
  }

  _collect(moduleId) {
    if (this.modules.has(moduleId)) return;
    const absolutePath = path.join(this.rootDirectory, moduleId);
    const source = readFileSync(absolutePath, 'utf8');
    this.modules.set(moduleId, source);

    for (const match of source.matchAll(IMPORT_PATTERN)) {
      this._collect(this._resolveImport(moduleId, match[2]));
    }
  }

  _createFactory(moduleId, source) {
    const exportedNames = [...source.matchAll(EXPORT_CLASS_PATTERN)]
      .map((match) => match[1]);
    const transformedSource = source
      .replace(IMPORT_PATTERN, (_statement, importedNames, importPath) => {
        const dependencyId = this._resolveImport(moduleId, importPath);
        return `const { ${importedNames.trim()} } = require(${JSON.stringify(dependencyId)});`;
      })
      .replace(/\bexport\s+class\s+/g, 'class ');
    const exportsStatement = exportedNames.length
      ? `\nObject.assign(exports, { ${exportedNames.join(', ')} });`
      : '';
    const indentedSource = `${transformedSource}${exportsStatement}`
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n');

    return `    ${JSON.stringify(moduleId)}: (module, exports, require) => {\n${indentedSource}\n    }`;
  }

  _resolveImport(moduleId, importPath) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(moduleId), importPath));
  }
}

try {
  new PlayerBundler(process.cwd()).build();
  console.log(`播放器 bundle 已生成：${OUTPUT_FILE}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
