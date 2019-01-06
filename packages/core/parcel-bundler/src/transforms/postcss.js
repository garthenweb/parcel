const localRequire = require('../utils/localRequire');
const loadPlugins = require('../utils/loadPlugins');
const SASSAsset = require('../assets/SASSAsset');
const postcss = require('postcss');
const FileSystemLoader = require('css-modules-loader-core/lib/file-system-loader');
const semver = require('semver');

module.exports = async function(asset) {
  let config = await getConfig(asset, {noMinify: true});
  if (!config) {
    return;
  }

  await asset.parseIfNeeded();
  let res = await postcss(config.plugins).process(asset.getCSSAst(), config);
  // TODO: only transform twice in case modules are active
  // TODO: use parser option from config to choose which asset should be used
  res = await SASSAsset.prototype.parse.call(asset, res.css);
  asset.ast = await asset.parse(res.css);
  config = await getConfig(asset, {noModules: true});
  res = await postcss(config.plugins).process(asset.getCSSAst(), config);

  asset.ast.css = res.css;
  asset.ast.dirty = false;
};

async function getConfig(asset, options) {
  const {noModules, noMinify} = Object.assign(
    {noModules: false, noMinify: false},
    options
  );
  let config = await asset.getConfig(
    ['.postcssrc', '.postcssrc.json', '.postcssrc.js', 'postcss.config.js'],
    {packageKey: 'postcss'}
  );

  let enableModules =
    asset.options.rendition && asset.options.rendition.modules;
  if (!config && !asset.options.minify && !enableModules) {
    return;
  }

  config = config || {};

  if (typeof config !== 'object') {
    throw new Error('PostCSS config should be an object.');
  }

  if (config.parser) {
    config.parser = await localRequire(config.parser, asset.name);
  }

  let postcssModulesConfig = !noModules
    ? {
        getJSON: (filename, json) => (asset.cssModules = json),
        Loader: createLoader(asset)
      }
    : {
        getJSON: () => {},
        generateScopedName: name => name
      };

  if (config.plugins && config.plugins['postcss-modules']) {
    postcssModulesConfig = Object.assign(
      config.plugins['postcss-modules'],
      postcssModulesConfig
    );
    delete config.plugins['postcss-modules'];
  }
  config.plugins = await loadPlugins(config.plugins, asset.name);

  if (config.modules || enableModules) {
    let postcssModules = await localRequire('postcss-modules', asset.name);
    config.plugins.push(postcssModules(postcssModulesConfig));
  }

  if (asset.options.minify && !noMinify) {
    let cssnano = await localRequire('cssnano', asset.name);
    let {version} = await localRequire('cssnano/package.json', asset.name);
    config.plugins.push(
      cssnano(
        (await asset.getConfig(['cssnano.config.js'])) || {
          // Only enable safe css transforms if cssnano < 4
          // See: https://github.com/parcel-bundler/parcel/issues/698
          // See: https://github.com/ben-eb/cssnano/releases/tag/v4.0.0-rc.0
          safe: semver.satisfies(version, '<4.0.0-rc')
        }
      )
    );
  }

  config.from = asset.name;
  config.to = asset.name;
  return config;
}

function createLoader(asset) {
  return class FileSystemParcelLoader extends FileSystemLoader {
    // TODO: add assets as dependencies to trigger hot reloading
    async fetch(_newPath, relativeTo, _trace) {
      let newPath = _newPath.replace(/^["']|["']$/g, '');
      if (newPath[0] !== '~' && newPath[0] !== '/' && newPath[0] !== '.') {
        newPath = await asset.resolver.resolveAliases(
          newPath,
          await asset.getPackage()
        );
      }
      return FileSystemLoader.prototype.fetch.call(
        this,
        newPath,
        relativeTo,
        _trace
      );
    }
  };
}
