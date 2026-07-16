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

function compileWithPlugins(plugins, callback) {
  const config = createWebpackConfig(plugins, undefined, 'index.js', {
    optimization: {
      realContentHash: false,
    },
  });
  webpackCompile(config, callback);
}

describe('CSP real content hash integration', () => {
  let hookFacade;

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

    compileWithPlugins(
      [
        new HtmlRspackPlugin({ filename: 'index.html', template: TEMPLATE }),
        interceptSpyPlugin,
        new CspHtmlRspackPlugin({}, PLUGIN_OPTIONS),
        inspectionPlugin,
      ],
      () => {
        expect([].concat(inspectionPlugin.info.contenthash || [])).toContain(
          oldHash
        );
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
