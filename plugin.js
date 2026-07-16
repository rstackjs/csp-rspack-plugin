const cheerio = require('cheerio');
const crypto = require('crypto');
const uniq = require('lodash/uniq');
const compact = require('lodash/compact');
const flatten = require('lodash/flatten');
const isFunction = require('lodash/isFunction');
const get = require('lodash/get');
const InjectPlugin = require('webpack-inject-plugin').default;

/**
 * The default function for adding the CSP to the head of a document
 * Can be overwritten to allow the developer to process the CSP in their own way
 * @param {string} builtPolicy
 * @param {object} htmlPluginData
 * @param {object} $
 */
const defaultProcessFn = (builtPolicy, htmlPluginData, $) => {
  let metaTag = $('meta[http-equiv="Content-Security-Policy"]');

  // Add element if it doesn't exist.
  if (!metaTag.length) {
    metaTag = cheerio.load('<meta http-equiv="Content-Security-Policy">')(
      'meta'
    );
    metaTag.prependTo($('head'));
  }

  // build the policy into the context attr of the csp meta tag
  metaTag.attr('content', builtPolicy);

  // eslint-disable-next-line no-param-reassign
  htmlPluginData.html = get(htmlPluginData, 'plugin.options.xhtml', false)
    ? $.xml()
    : $.html();
};

const defaultPolicy = {
  'base-uri': "'self'",
  'object-src': "'none'",
  'script-src': ["'unsafe-inline'", "'self'", "'unsafe-eval'"],
  'style-src': ["'unsafe-inline'", "'self'", "'unsafe-eval'"],
};

const defaultAdditionalOpts = {
  htmlPlugin: 'HtmlRspackPlugin',
  enabled: true,
  integrityEnabled: true,
  primeReactEnabled: true,
  trustedTypesEnabled: true,
  hashingMethod: 'sha384',
  hashEnabled: {
    'script-src': true,
    'style-src': true,
  },
  nonceEnabled: {
    'script-src': true,
    'style-src': true,
  },
  processFn: defaultProcessFn,
};

class CspHtmlRspackPlugin {
  /**
   * Setup for our plugin
   * @param {object} policy - the policy object - see defaultPolicy above for the structure
   * @param {object} additionalOpts - additional config options - see defaultAdditionalOpts above for options available
   */
  constructor(policy = {}, additionalOpts = {}) {
    // the policy passed in from the CspHtmlRspackPlugin instance
    this.cspPluginPolicy = Object.freeze(policy);

    // the additional options that this plugin allows
    this.opts = Object.freeze({ ...defaultAdditionalOpts, ...additionalOpts });

    // special NONCE for PrimeReact inline styles
    this.primeReactInlineNonce = this.createNonce();

    // generated CSP hashes grouped by compilation
    this.realContentHashRecords = new WeakMap();

    // valid hashes from https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src#Sources
    if (!['sha256', 'sha384', 'sha512'].includes(this.opts.hashingMethod)) {
      throw new Error(
        `'${this.opts.hashingMethod}' is not a valid hashing method`
      );
    }
  }

  /**
   * Builds options based on settings passed into the CspHtmlRspackPlugin instance, and the HtmlWebpackPlugin instance
   * Policy: combines default, csp instance and html webpack instance policies defined. Latter policy rules always override former
   * HashEnabled: sets whether we should add hashes for inline scripts/styles
   * NonceEnabled: sets whether we should add nonce attrs for external scripts/styles
   * @param {object} compilation - the webpack compilation object
   * @param {object} htmlPluginData - the HtmlWebpackPlugin data object
   * @param {function} compileCb - the callback function to continue webpack compilation
   */
  mergeOptions(compilation, htmlPluginData, compileCb) {
    // 1. Let's create the policy we want to use for this HtmlWebpackPlugin instance
    // CspHtmlRspackPlugin and HtmlWebpackPlugin policies merged
    const userPolicy = Object.freeze({
      ...this.cspPluginPolicy,
      ...get(htmlPluginData, 'plugin.options.cspPlugin.policy', {}),
    });

    // defaultPolicy and userPolicy merged
    this.policy = Object.freeze({ ...defaultPolicy, ...userPolicy });

    // and now validate it
    this.validatePolicy(compilation);

    // 2. Lets set which hashes and nonces are enabled for this HtmlWebpackPlugin instance
    this.hashEnabled = Object.freeze({
      ...this.opts.hashEnabled,
      ...get(htmlPluginData, 'plugin.options.cspPlugin.hashEnabled', {}),
    });

    this.nonceEnabled = Object.freeze({
      ...this.opts.nonceEnabled,
      ...get(htmlPluginData, 'plugin.options.cspPlugin.nonceEnabled', {}),
    });

    // 3. Get the processFn for this HtmlWebpackPlugin instance.
    this.processFn = get(
      htmlPluginData,
      'plugin.options.cspPlugin.processFn',
      this.opts.processFn
    );

    return compileCb(null, htmlPluginData);
  }

  /**
   * Validate the policy by making sure that all static sources have been wrapped in apostrophes
   * i.e. policy should contain 'self' instead of self
   * @param {object} compilation - the webpack compilation object
   */
  validatePolicy(compilation) {
    const staticSources = [
      'self',
      'unsafe-inline',
      'unsafe-eval',
      'none',
      'strict-dynamic',
      'report-sample',
    ];
    const sourcesRegexes = staticSources.map(
      (source) => new RegExp(`\\s${source}\\s`)
    );

    Object.keys(this.policy).forEach((key) => {
      const val = Array.isArray(this.policy[key])
        ? compact(uniq(this.policy[key])).join(' ')
        : this.policy[key];

      for (let i = 0, len = sourcesRegexes.length; i < len; i += 1) {
        if (` ${val} `.match(sourcesRegexes[i])) {
          compilation.errors.push(
            new Error(
              `CSP: policy for ${key} contains ${staticSources[i]} which should be wrapped in apostrophes`
            )
          );
        }
      }
    });
  }

  /**
   * Checks to see whether the plugin is enabled. this.opts.enabled can be a function or bool here
   * @param htmlPluginData - the htmlPluginData from compilation
   * @return {boolean} - whether the plugin is enabled or not
   */
  isEnabled(htmlPluginData) {
    const cspPluginEnabled = get(
      htmlPluginData,
      'plugin.options.cspPlugin.enabled'
    );
    if (cspPluginEnabled === false) {
      // the HtmlWebpackPlugin instance has disabled the plugin
      return false;
    }

    if (isFunction(this.opts.enabled)) {
      // run the function to check if the plugin has been disabled
      return this.opts.enabled(htmlPluginData);
    }

    // otherwise assume it's a boolean
    return this.opts.enabled;
  }

  /**
   * Create a random nonce which we will set onto our assets
   * @return {string}
   */
  // eslint-disable-next-line class-methods-use-this
  createNonce() {
    return crypto.randomBytes(16).toString('base64');
  }

  /**
   * Generates nonces for the policy / selector we define
   * @param {object} $ - the Cheerio instance
   * @param {string} policyName - one of 'script-src' and 'style-src'
   * @param {string} selector - a Cheerio selector string for getting the hashable elements for this policy
   * @return {string[]}
   */
  setNonce($, policyName, selector) {
    if (this.nonceEnabled[policyName] === false) {
      // we don't want to add any nonce for this specific policy
      return [];
    }

    const policy = this.policy[policyName];
    const policyStr = Array.isArray(policy) ? policy.join(' ') : policy;

    // get a list of already defined urls for this policy type
    const urls = policyStr.match(/https?:\/\/[^'"]+/g) || [];

    // check if the user has defined 'strict-dynamic' in their policy
    // if so, we will need to include the nonce even if the domain has been whitelisted for it
    const hasStrictDynamic = policyStr.includes("'strict-dynamic'");

    return $(selector)
      .map((i, element) => {
        // get the src/href and check if it's already been whitelisted by the user.
        // if it has, and the dev hasn't defined strict-dynamic, there's no reason to add a nonce for it
        if (!hasStrictDynamic) {
          const srcOrHref = $(element).attr('src') || $(element).attr('href');
          for (let j = 0, len = urls.length; j < len; j += 1) {
            if (srcOrHref.startsWith(urls[j])) {
              return null;
            }
          }
        }

        // create a nonce, and attach to the script tag
        const nonce = this.createNonce();
        $(element).attr('nonce', nonce);

        // return in the format csp needs
        return `'nonce-${nonce}'`;
      })
      .filter((entry) => entry !== null)
      .get();
  }

  /**
   * Hashes a string using the hashing method we have opted for and then base64 encodes the result
   * @param {string} str - the string to hash
   * @returns {string} - the returned hash with the hashing method prepended e.g. sha256-123456abcdef
   */
  hash(str) {
    const hashed = crypto
      .createHash(this.opts.hashingMethod)
      .update(str, 'utf8')
      .digest('base64');

    return `'${this.opts.hashingMethod}-${hashed}'`;
  }

  /**
   * Calculates shas of the policy / selector we define
   * @param {object} $ - the Cheerio instance
   * @param {string} policyName - one of 'script-src' and 'style-src'
   * @param {string} selector - a Cheerio selector string for getting the hashable elements for this policy
   * @return {string[]}
   */
  getShas($, policyName, selector) {
    if (this.hashEnabled[policyName] === false) {
      // we don't want to add any nonce for this specific policy
      return [];
    }

    return $(selector)
      .map((i, element) => this.hash($(element).html()))
      .get();
  }

  /**
   * Calculates CSP hashes and retains enough information to recompute them
   * after RealContentHashPlugin updates embedded content hashes.
   * @param {object} $ - the Cheerio instance
   * @param {string} policyName - one of 'script-src' and 'style-src'
   * @param {string} selector - a Cheerio selector string for hashable elements
   * @returns {object[]}
   */
  getHashRecords($, policyName, selector) {
    if (this.hashEnabled[policyName] === false) {
      // we don't want to add any nonce for this specific policy
      return [];
    }

    return $(selector)
      .map((index, element) => {
        const quotedHash = this.hash($(element).html());
        return {
          quotedHash,
          hash: quotedHash.slice(1, -1),
          selector,
          index,
          hashingMethod: this.opts.hashingMethod,
        };
      })
      .get();
  }

  /**
   * Records generated CSP hashes that remain embedded in the output HTML.
   * @param {object} compilation - the webpack compilation
   * @param {object} htmlPluginData - HtmlRspackPlugin/HtmlWebpackPlugin data
   * @param {object[]} hashRecords - generated inline element hash records
   */
  recordRealContentHashes(compilation, htmlPluginData, hashRecords) {
    const compilationRecords = this.realContentHashRecords.get(compilation);
    if (!compilationRecords || !htmlPluginData.outputName) {
      return;
    }

    hashRecords
      .filter((record) => htmlPluginData.html.includes(record.hash))
      .forEach((record) => {
        const records = compilationRecords.get(record.hash) || [];
        records.push({
          ...record,
          outputName: htmlPluginData.outputName,
          xmlMode: get(htmlPluginData, 'plugin.options.xhtml', false),
        });
        compilationRecords.set(record.hash, records);
      });
  }

  /**
   * Adds generated CSP hashes to HTML asset metadata so RealContentHashPlugin
   * includes them in its dependency-aware update pass.
   * @param {object} compilation - the webpack compilation
   */
  registerAssetContentHashes(compilation) {
    const compilationRecords = this.realContentHashRecords.get(compilation);
    if (!compilationRecords) {
      return;
    }

    const matchedRecords = new Map();
    compilation.getAssets().forEach(({ name, source: assetSource }) => {
      const content = assetSource.source().toString();
      const hashes = new Set();
      const parsedHtml = new Map();
      compilationRecords.forEach((records, hash) => {
        if (!content.includes(hash)) return;
        const recordsForAsset = records.filter((record) => {
          const xmlMode = Boolean(record.xmlMode);
          let $ = parsedHtml.get(xmlMode);
          if (!$) {
            $ = cheerio.load(content, {
              decodeEntities: false,
              _useHtmlParser2: true,
              xmlMode,
            });
            parsedHtml.set(xmlMode, $);
          }
          const inlineContent = $(record.selector).eq(record.index).html();
          if (inlineContent === null) return false;
          const inlineHash = crypto
            .createHash(record.hashingMethod)
            .update(inlineContent, 'utf8')
            .digest('base64');
          return `${record.hashingMethod}-${inlineHash}` === hash;
        });
        if (recordsForAsset.length === 0) return;
        hashes.add(hash);
        const recordsForHash = matchedRecords.get(hash) || [];
        recordsForHash.push(
          ...recordsForAsset.map((record) => ({
            ...record,
            outputName: name,
          }))
        );
        matchedRecords.set(hash, recordsForHash);
      });

      if (hashes.size === 0) return;
      compilation.updateAsset(
        name,
        (currentSource) => currentSource,
        (assetInfo) => {
          let contenthash = [...hashes];
          if (Array.isArray(assetInfo.contenthash)) {
            contenthash = [
              ...new Set([...assetInfo.contenthash, ...contenthash]),
            ];
          } else if (assetInfo.contenthash) {
            contenthash = [...new Set([assetInfo.contenthash, ...contenthash])];
          }
          return { ...assetInfo, contenthash };
        }
      );
    });
    this.realContentHashRecords.set(compilation, matchedRecords);
  }

  /**
   * Recomputes a generated CSP hash from HTML after referenced content hashes
   * have been updated by RealContentHashPlugin.
   * @param {object} compilation - the webpack compilation
   * @param {Buffer[]} assets - final asset contents for the old hash
   * @param {string} oldHash - generated CSP hash before content updates
   * @returns {string|undefined}
   */
  updateCspHash(compilation, assets, oldHash) {
    const compilationRecords = this.realContentHashRecords.get(compilation);
    const records = compilationRecords && compilationRecords.get(oldHash);
    if (!records) {
      return undefined;
    }

    const deduplicateRecords = (items) => [
      ...new Map(
        items.map((record) => [
          `${record.selector}:${record.index}:${record.hashingMethod}:${record.xmlMode}`,
          record,
        ])
      ).values(),
    ];
    const recordsByOutput = new Map();
    records.forEach((record) => {
      const outputRecords = recordsByOutput.get(record.outputName) || [];
      outputRecords.push(record);
      recordsByOutput.set(record.outputName, outputRecords);
    });
    const orderedOutputRecords = [...recordsByOutput.entries()]
      .sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      })
      .map(([, outputRecords]) => deduplicateRecords(outputRecords));
    const fallbackRecords = deduplicateRecords(records);
    const recordsByAsset =
      assets.length === orderedOutputRecords.length
        ? orderedOutputRecords
        : assets.map(() => fallbackRecords);
    const candidates = new Set();
    assets.forEach((asset, assetIndex) => {
      recordsByAsset[assetIndex].forEach((record) => {
        const $ = cheerio.load(asset.toString(), {
          decodeEntities: false,
          _useHtmlParser2: true,
          xmlMode: record.xmlMode,
        });
        const content = $(record.selector).eq(record.index).html();
        if (content !== null) {
          const hash = crypto
            .createHash(record.hashingMethod)
            .update(content, 'utf8')
            .digest('base64');
          candidates.add(`${record.hashingMethod}-${hash}`);
        }
      });
    });

    if (candidates.size === 1) {
      return candidates.values().next().value;
    }

    compilation.errors.push(
      new Error(`CSP: unable to uniquely update real content hash ${oldHash}`)
    );
    return undefined;
  }

  /**
   * Builds the CSP policy by flattening arrays into strings and appending all policies into a single string
   * @param policyObj
   * @returns {string}
   */
  // eslint-disable-next-line class-methods-use-this
  buildPolicy(policyObj) {
    return Object.keys(policyObj)
      .map((key) => {
        const val = Array.isArray(policyObj[key])
          ? compact(uniq(policyObj[key])).join(' ')
          : policyObj[key];

        // move strict dynamic to the end of the policy if it exists to be backwards compatible with csp2
        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src#strict-dynamic
        if (val.includes("'strict-dynamic'")) {
          const newVal = `${val
            .replace(/\s?'strict-dynamic'\s?/gi, ' ')
            .trim()} 'strict-dynamic'`;
          return `${key} ${newVal}`;
        }

        return `${key} ${val}`;
      })
      .join('; ');
  }

  /**
   * Processes HtmlWebpackPlugin's html data adding the CSP defined
   * @param htmlPluginData
   * @param compileCb
   */
  async processCsp(compilation, htmlPluginData, compileCb) {
    const $ = cheerio.load(htmlPluginData.html, {
      decodeEntities: false,
      _useHtmlParser2: true,
      xmlMode: get(htmlPluginData, 'plugin.options.xhtml', false),
    });

    // if not enabled, remove the empty tag
    if (!this.isEnabled(htmlPluginData)) {
      return compileCb(null, htmlPluginData);
    }

    // get all nonces for script and style tags
    // get all nonces for linked script and style tags
    const scriptNonce = this.setNonce(
      $,
      'script-src',
      'script[src], [data-csp="script-src"]'
    );
    const styleNonce = this.setNonce($, 'style-src', 'link[rel="stylesheet"]');
    if (this.opts.primeReactEnabled) {
      styleNonce.push(`'nonce-${this.primeReactInlineNonce}'`);
    }

    // get all shas for script and style tags
    const trackRealContentHashes = this.realContentHashRecords.has(compilation);
    const scriptHashRecords = trackRealContentHashes
      ? this.getHashRecords($, 'script-src', 'script:not([src])')
      : [];
    const styleHashRecords = trackRealContentHashes
      ? this.getHashRecords($, 'style-src', 'style:not([href])')
      : [];
    const scriptShas = trackRealContentHashes
      ? scriptHashRecords.map(({ quotedHash }) => quotedHash)
      : this.getShas($, 'script-src', 'script:not([src])');
    const styleShas = trackRealContentHashes
      ? styleHashRecords.map(({ quotedHash }) => quotedHash)
      : this.getShas($, 'style-src', 'style:not([href])');

    const builtPolicy = this.buildPolicy({
      ...this.policy,
      'script-src': flatten([this.policy['script-src']]).concat(
        scriptShas,
        scriptNonce
      ),
      'style-src': flatten([this.policy['style-src']]).concat(
        styleShas,
        styleNonce
      ),
    });

    this.processFn(builtPolicy, htmlPluginData, $, compilation);
    if (trackRealContentHashes) {
      this.recordRealContentHashes(compilation, htmlPluginData, [
        ...scriptHashRecords,
        ...styleHashRecords,
      ]);
    }

    return compileCb(null, htmlPluginData);
  }

  /**
   * Hooks into webpack to collect assets and hash them, build the policy, and add it into our HTML template
   * @param compiler
   */
  apply(compiler) {
    const { DefinePlugin, experiments, HtmlRspackPlugin } = compiler.webpack;
    const { SubresourceIntegrityPlugin } = experiments;
    const HtmlPlugin =
      this.opts.htmlPlugin === 'HtmlRspackPlugin'
        ? HtmlRspackPlugin
        : require(this.opts.htmlPlugin);
    const bundler = compiler.rspack || compiler.webpack;

    compiler.hooks.compilation.tap('CspHtmlRspackPlugin', (compilation) => {
      const RealContentHashPlugin =
        bundler.optimize && bundler.optimize.RealContentHashPlugin;
      if (
        compilation.options.optimization.realContentHash &&
        RealContentHashPlugin &&
        typeof RealContentHashPlugin.getCompilationHooks === 'function'
      ) {
        this.realContentHashRecords.set(compilation, new Map());
        RealContentHashPlugin.getCompilationHooks(compilation).updateHash.tap(
          'CspHtmlRspackPlugin',
          (assets, oldHash) => this.updateCspHash(compilation, assets, oldHash)
        );
        compilation.hooks.processAssets.tap(
          {
            name: 'CspHtmlRspackPlugin',
            stage: bundler.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE + 1,
          },
          () => this.registerAssetContentHashes(compilation)
        );
      }

      HtmlPlugin.getCompilationHooks(
        compilation
      ).beforeAssetTagGeneration.tapAsync(
        'CspHtmlRspackPlugin',
        this.mergeOptions.bind(this, compilation)
      );
      HtmlPlugin.getCompilationHooks(compilation).beforeEmit.tapAsync(
        'CspHtmlRspackPlugin',
        this.processCsp.bind(this, compilation)
      );
    });

    // special handling for PrimeReact inline styles
    if (this.opts.enabled && this.opts.primeReactEnabled) {
      const definitions = {};
      definitions['process.env.REACT_APP_CSS_NONCE'] = JSON.stringify(
        this.primeReactInlineNonce
      );
      new DefinePlugin(definitions).apply(compiler);
    }

    // add SHA384 integrity attributes to JS and CSS files
    if (this.opts.enabled && this.opts.integrityEnabled) {
      new SubresourceIntegrityPlugin({
        htmlPlugin: this.opts.htmlPlugin,
      }).apply(compiler);
    }

    // add default TrustedTypes policy which uses DOMPurify to sanitize HTML
    if (
      this.opts.enabled &&
      this.opts.trustedTypesEnabled &&
      this.cspPluginPolicy['require-trusted-types-for']
    ) {
      const purifyScript = `import DOMPurify from 'dompurify';
function sanitizeUrl(r){if(!r)return"about:blank";var t=r.replace(/[\u0000-\u001F\u007F-\u009F\u2000-\u200D\uFEFF]/gim,"").trim();if([".","/"].indexOf(t[0])>-1)return t;var a=t.match(/^([^:]+):/gm);if(!a)return t;var u=a[0];return/^([^\\w]*)(javascript|data|vbscript)/im.test(u)?"about:blank":t};
if (window.trustedTypes && window.trustedTypes.createPolicy) {
    window.trustedTypes.createPolicy('default', {
        createHTML: (string) => DOMPurify.sanitize(string, {RETURN_TRUSTED_TYPE: true}),
        createScriptURL: string => sanitizeUrl(string),
        createScript: string => string // allow scripts
    });
}`;
      new InjectPlugin(() => purifyScript).apply(compiler);
    }
  }
}

module.exports = CspHtmlRspackPlugin;
