const crypto = require('crypto');
const path = require('path');
const rspack = require('@rspack/core');
const CspHtmlRspackPlugin = require('./plugin');
const {
  createWebpackConfig,
  webpackCompile,
} = require('./test-utils/webpack-helpers');

const {
  Compilation,
  HtmlRspackPlugin,
  sources: { RawSource },
} = rspack;

const PLUGIN_OPTIONS = {
  enabled: true,
  integrityEnabled: false,
  primeReactEnabled: false,
  hashingMethod: 'sha384',
  hashEnabled: {
    'script-src': true,
    'style-src': true,
  },
  nonceEnabled: {
    'script-src': false,
    'style-src': false,
  },
};

const TEMPLATE = path.join(
  __dirname,
  'test-utils',
  'fixtures',
  'with-content-hash-script.html'
);

const digest = (algorithm, content) =>
  `${algorithm}-${crypto
    .createHash(algorithm)
    .update(content, 'utf8')
    .digest('base64')}`;

function installRealContentHashHookFacade() {
  let updateHash;
  const original = rspack.optimize.RealContentHashPlugin;
  rspack.optimize.RealContentHashPlugin = {
    getCompilationHooks() {
      return {
        updateHash: {
          tap(_name, callback) {
            updateHash = callback;
          },
        },
      };
    },
  };
  return {
    getUpdateHash: () => updateHash,
    restore() {
      if (original === undefined) {
        delete rspack.optimize.RealContentHashPlugin;
      } else {
        rspack.optimize.RealContentHashPlugin = original;
      }
    },
  };
}

function createRealContentHashPluginFacade() {
  let updateHash;
  return {
    plugin: {
      getCompilationHooks() {
        return {
          updateHash: {
            tap(_name, callback) {
              updateHash = callback;
            },
          },
        };
      },
    },
    getUpdateHash: () => updateHash,
  };
}

function createBundlerNamespacePlugin(rspackFacade, webpackFacade) {
  return {
    apply(compiler) {
      if (rspackFacade) {
        const rspackNamespace = Object.create(compiler.rspack);
        rspackNamespace.optimize = {
          ...compiler.rspack.optimize,
          RealContentHashPlugin: rspackFacade.plugin,
        };
        Reflect.set(compiler, 'rspack', rspackNamespace);
      } else {
        Reflect.set(compiler, 'rspack', undefined);
      }

      const webpackNamespace = Object.create(compiler.webpack);
      webpackNamespace.optimize = {
        ...compiler.webpack.optimize,
        RealContentHashPlugin: webpackFacade.plugin,
      };
      Reflect.set(compiler, 'webpack', webpackNamespace);
    },
  };
}

class InspectionPlugin {
  apply(compiler) {
    compiler.hooks.compilation.tap('InspectionPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'InspectionPlugin',
          stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE + 2,
        },
        () => {
          const asset = compilation.getAsset('index.html');
          this.html = asset.source.source().toString();
          this.info = asset.info;
          this.header = compilation.getAsset('csp-header.txt');
        }
      );
    });
  }
}

function createAssetsInspectionPlugin(outputNames) {
  const assets = new Map();
  return {
    assets,
    apply(compiler) {
      compiler.hooks.compilation.tap(
        'AssetsInspectionPlugin',
        (compilation) => {
          compilation.hooks.processAssets.tap(
            {
              name: 'AssetsInspectionPlugin',
              stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE + 2,
            },
            () => {
              outputNames.forEach((outputName) => {
                assets.set(outputName, compilation.getAsset(outputName));
              });
            }
          );
        }
      );
    },
  };
}

function createHtmlAssetsInspectionPlugin() {
  const assets = new Map();
  return {
    assets,
    apply(compiler) {
      compiler.hooks.compilation.tap(
        'HtmlAssetsInspectionPlugin',
        (compilation) => {
          compilation.hooks.processAssets.tap(
            {
              name: 'HtmlAssetsInspectionPlugin',
              stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE + 2,
            },
            () => {
              compilation.getAssets().forEach((asset) => {
                if (asset.name.endsWith('.html')) {
                  assets.set(asset.name, asset);
                }
              });
            }
          );
        }
      );
    },
  };
}

function createInterceptSpyPlugin() {
  let interceptCalls = 0;
  return {
    get interceptCalls() {
      return interceptCalls;
    },
    apply(compiler) {
      compiler.hooks.compilation.tap('InterceptSpyPlugin', (compilation) => {
        const { processAssets } = compilation.hooks;
        const originalIntercept = processAssets.intercept;
        processAssets.intercept = (...args) => {
          interceptCalls += 1;
          return originalIntercept.apply(processAssets, args);
        };
      });
    },
  };
}

function compileWithPlugins(plugins, callback, realContentHash = true) {
  const config = createWebpackConfig(plugins, undefined, 'index.js', {
    optimization: {
      realContentHash,
    },
  });
  webpackCompile(config, callback);
}

describe('CSP real content hash integration', () => {
  let hookFacade;

  it('exports the Rspack plugin class name', () => {
    expect(CspHtmlRspackPlugin.name).toBe('CspHtmlRspackPlugin');
  });

  afterEach(() => {
    if (hookFacade) {
      hookFacade.restore();
    }
    hookFacade = undefined;
  });

  it('registers generated CSP hashes and recomputes them from final HTML', (done) => {
    hookFacade = installRealContentHashHookFacade();
    const inspectionPlugin = new InspectionPlugin();
    const interceptSpyPlugin = createInterceptSpyPlugin();
    const oldBody = 'loadChunk("async-old-content-hash.js")';
    const newBody = 'loadChunk("async-new-content-hash.js")';
    const oldHash = digest('sha384', oldBody);
    const newHash = digest('sha384', newBody);
    const userHash = 'sha384-user-provided-policy-hash';

    compileWithPlugins(
      [
        new HtmlRspackPlugin({ filename: 'index.html', template: TEMPLATE }),
        interceptSpyPlugin,
        new CspHtmlRspackPlugin(
          { 'script-src': ["'self'", `'${userHash}'`] },
          PLUGIN_OPTIONS
        ),
        inspectionPlugin,
      ],
      (csps) => {
        const contentHashes = [].concat(
          inspectionPlugin.info.contenthash || []
        );
        expect(contentHashes).toContain(oldHash);
        expect(contentHashes).not.toContain(userHash);
        expect(csps['index.html']).toContain(`'${userHash}'`);
        expect(hookFacade.getUpdateHash()).toEqual(expect.any(Function));
        expect(
          hookFacade.getUpdateHash()(
            [Buffer.from(inspectionPlugin.html.replace(oldBody, newBody))],
            oldHash
          )
        ).toBe(newHash);
        expect(interceptSpyPlugin.interceptCalls).toBe(0);
        done();
      }
    );
  });

  it('skips real content hash hooks and metadata when disabled', (done) => {
    hookFacade = installRealContentHashHookFacade();
    const inspectionPlugin = new InspectionPlugin();
    const cspPlugin = new CspHtmlRspackPlugin({}, PLUGIN_OPTIONS);
    const getHashRecords = jest.spyOn(cspPlugin, 'getHashRecords');
    const recordRealContentHashes = jest.spyOn(
      cspPlugin,
      'recordRealContentHashes'
    );
    const oldHash = digest('sha384', 'loadChunk("async-old-content-hash.js")');

    compileWithPlugins(
      [
        new HtmlRspackPlugin({ filename: 'index.html', template: TEMPLATE }),
        cspPlugin,
        inspectionPlugin,
      ],
      () => {
        expect(hookFacade.getUpdateHash()).toBeUndefined();
        expect(
          [].concat(inspectionPlugin.info.contenthash || [])
        ).not.toContain(oldHash);
        expect(getHashRecords).not.toHaveBeenCalled();
        expect(recordRealContentHashes).not.toHaveBeenCalled();
        done();
      },
      false
    );
  });

  it('prefers the Rspack namespace for real content hash hooks', (done) => {
    const rspackFacade = createRealContentHashPluginFacade();
    const webpackFacade = createRealContentHashPluginFacade();

    compileWithPlugins(
      [
        createBundlerNamespacePlugin(rspackFacade, webpackFacade),
        new HtmlRspackPlugin({ filename: 'index.html', template: TEMPLATE }),
        new CspHtmlRspackPlugin({}, PLUGIN_OPTIONS),
      ],
      () => {
        expect(rspackFacade.getUpdateHash()).toEqual(expect.any(Function));
        expect(webpackFacade.getUpdateHash()).toBeUndefined();
        done();
      }
    );
  });

  it('falls back to the webpack namespace for real content hash hooks', (done) => {
    const webpackFacade = createRealContentHashPluginFacade();

    compileWithPlugins(
      [
        createBundlerNamespacePlugin(null, webpackFacade),
        new HtmlRspackPlugin({ filename: 'index.html', template: TEMPLATE }),
        new CspHtmlRspackPlugin({}, PLUGIN_OPTIONS),
      ],
      () => {
        expect(webpackFacade.getUpdateHash()).toEqual(expect.any(Function));
        done();
      }
    );
  });

  it('matches shared hashes to their corresponding HTML output', (done) => {
    hookFacade = installRealContentHashHookFacade();
    const inspectionPlugin = createAssetsInspectionPlugin([
      'first.html',
      'second.html',
    ]);
    const oldBody = 'loadChunk("async-old-content-hash.js")';
    const newBody = 'loadChunk("async-new-content-hash.js")';
    const oldHash = digest('sha384', oldBody);
    const newHash = digest('sha384', newBody);

    compileWithPlugins(
      [
        new HtmlRspackPlugin({
          filename: 'first.html',
          templateContent: `<html><body><script>${oldBody}</script></body></html>`,
        }),
        new HtmlRspackPlugin({
          filename: 'second.html',
          templateContent: `<html><body><script>unrelated()</script><script>${oldBody}</script></body></html>`,
        }),
        new CspHtmlRspackPlugin({}, PLUGIN_OPTIONS),
        inspectionPlugin,
      ],
      () => {
        const finalAssets = ['first.html', 'second.html'].map((outputName) =>
          Buffer.from(
            inspectionPlugin.assets
              .get(outputName)
              .source.source()
              .toString()
              .replace(oldBody, newBody)
          )
        );
        expect(hookFacade.getUpdateHash()(finalAssets, oldHash)).toBe(newHash);
        done();
      }
    );
  });

  it('registers hashes on HTML filenames with contenthash placeholders', (done) => {
    hookFacade = installRealContentHashHookFacade();
    const inspectionPlugin = createHtmlAssetsInspectionPlugin();
    const oldHash = digest('sha384', 'loadChunk("async-old-content-hash.js")');

    compileWithPlugins(
      [
        new HtmlRspackPlugin({
          filename: 'page.[contenthash].html',
          template: TEMPLATE,
        }),
        new CspHtmlRspackPlugin({}, PLUGIN_OPTIONS),
        inspectionPlugin,
      ],
      () => {
        const [[outputName, asset]] = inspectionPlugin.assets;
        expect(outputName).not.toContain('[contenthash]');
        expect([].concat(asset.info.contenthash || [])).toContain(oldHash);
        done();
      }
    );
  });

  it('keeps existing behavior when the RealContentHash hook is unavailable', (done) => {
    const inspectionPlugin = new InspectionPlugin();
    const oldHash = digest('sha384', 'loadChunk("async-old-content-hash.js")');

    compileWithPlugins(
      [
        new HtmlRspackPlugin({ filename: 'index.html', template: TEMPLATE }),
        new CspHtmlRspackPlugin({}, PLUGIN_OPTIONS),
        inspectionPlugin,
      ],
      (csps) => {
        expect(csps['index.html']).toContain(`'${oldHash}'`);
        expect(
          [].concat(inspectionPlugin.info.contenthash || [])
        ).not.toContain(oldHash);
        done();
      }
    );
  });

  it('does not register hashes emitted only by a custom processFn', (done) => {
    hookFacade = installRealContentHashHookFacade();
    const inspectionPlugin = new InspectionPlugin();
    const oldHash = digest('sha384', 'loadChunk("async-old-content-hash.js")');
    const options = {
      ...PLUGIN_OPTIONS,
      processFn(builtPolicy, _htmlPluginData, _$, compilation) {
        compilation.emitAsset('csp-header.txt', new RawSource(builtPolicy));
      },
    };

    compileWithPlugins(
      [
        new HtmlRspackPlugin({ filename: 'index.html', template: TEMPLATE }),
        new CspHtmlRspackPlugin({}, options),
        inspectionPlugin,
      ],
      (csps) => {
        expect(csps['index.html']).toBeUndefined();
        expect(inspectionPlugin.header.source.source().toString()).toContain(
          `'${oldHash}'`
        );
        expect(
          [].concat(inspectionPlugin.info.contenthash || [])
        ).not.toContain(oldHash);
        expect(hookFacade.getUpdateHash()([], oldHash)).toBeUndefined();
        done();
      }
    );
  });
});
