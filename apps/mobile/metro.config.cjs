const { getDefaultConfig } = require('expo/metro-config');
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');
const { runtimeFiles } = require('./runtime-files.cjs');
const config = getDefaultConfig(__dirname);
const files = runtimeFiles(process.env.APP_MODE, process.env.APP_ENV);
const demoAssets = 'src/local/gallery-demo/assets.local/index.cjs';
if (
  process.env.APP_MODE === 'local' &&
  existsSync(resolve(__dirname, demoAssets))
)
  files['@puzzle-sns/gallery-demo-assets'] = demoAssets;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (Object.hasOwn(files, moduleName)) {
    if (process.env.APP_MODE === 'local' && !context.dev)
      throw new Error('Local runtime is Debug-only');
    return {
      type: 'sourceFile',
      filePath: resolve(__dirname, files[moduleName]),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
