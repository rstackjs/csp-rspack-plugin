import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/* eslint-disable no-console */

const require = createRequire(import.meta.url);
const cheerio = require('cheerio');
const CspHtmlRspackPlugin = require('./plugin');

const root = path.dirname(fileURLToPath(import.meta.url));

const digest = (algorithm, content) =>
  `${algorithm}-${crypto
    .createHash(algorithm)
    .update(content)
    .digest('base64')}`;

function createInlineRuntimeAndStylePlugin(HtmlRspackPlugin) {
  return {
    apply(compiler) {
      compiler.hooks.compilation.tap(
        'InlineRuntimeAndStylePlugin',
        (compilation) => {
          HtmlRspackPlugin.getCompilationHooks(compilation).beforeEmit.tapAsync(
            'InlineRuntimeAndStylePlugin',
            (data, callback) => {
              const $ = cheerio.load(data.html, {
                decodeEntities: false,
                _useHtmlParser2: true,
              });
              const asyncFile = compilation
                .getAssets()
                .map(({ name }) => name)
                .find(
                  (name) =>
                    name.endsWith('.js') &&
                    !name.startsWith('main.') &&
                    !name.startsWith('runtime.')
                );
              $('head').append(
                `<style id="real-content-hash-style">.chunk{--file:"${asyncFile}"}</style>`
              );
              $('script[src]').each((_, element) => {
                const src = $(element).attr('src');
                if (!src || !src.startsWith('runtime.')) return;
                const asset = compilation.getAsset(src);
                $(element).removeAttr('src');
                $(element).removeAttr('integrity');
                $(element).removeAttr('crossorigin');
                $(element).html(asset.source.source());
              });
              callback(null, { ...data, html: $.html() });
            }
          );
        }
      );
    },
  };
}

function runCompiler(compiler) {
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) {
        reject(error);
        return;
      }
      compiler.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(stats);
      });
    });
  });
}

async function main() {
  const core = await import('@rspack/core');
  const rspack = core.rspack || core.default;
  if (
    !rspack.optimize.RealContentHashPlugin ||
    typeof rspack.optimize.RealContentHashPlugin.getCompilationHooks !==
      'function'
  ) {
    console.log('SKIP native RealContentHash integration: hook is unavailable');
    return;
  }

  if (
    !rspack.experiments.SubresourceIntegrityPlugin &&
    rspack.SubresourceIntegrityPlugin
  ) {
    rspack.experiments.SubresourceIntegrityPlugin =
      rspack.SubresourceIntegrityPlugin;
  }

  const outputPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'csp-rspack-real-content-hash-')
  );
  try {
    const config = {
      mode: 'production',
      context: root,
      entry: path.join(
        root,
        'test-utils',
        'fixtures',
        'real-content-hash-entry.js'
      ),
      output: {
        path: outputPath,
        publicPath: '',
        filename: '[name].[contenthash].js',
        chunkFilename: '[name].[contenthash].js',
        crossOriginLoading: 'anonymous',
      },
      optimization: {
        realContentHash: true,
        runtimeChunk: 'single',
      },
      plugins: [
        new rspack.HtmlRspackPlugin({
          filename: 'index.html',
          templateContent: '<html><head></head><body></body></html>',
        }),
        createInlineRuntimeAndStylePlugin(rspack.HtmlRspackPlugin),
        new CspHtmlRspackPlugin(
          {
            'script-src': ["'self'"],
            'style-src': ["'self'"],
          },
          {
            enabled: true,
            integrityEnabled: true,
            primeReactEnabled: false,
            trustedTypesEnabled: false,
            hashingMethod: 'sha384',
            hashEnabled: {
              'script-src': true,
              'style-src': true,
            },
            nonceEnabled: {
              'script-src': false,
              'style-src': false,
            },
          }
        ),
      ],
    };
    const stats = await runCompiler(rspack(config));
    const info = stats.toJson({ all: false, errors: true, warnings: true });
    assert.deepEqual(info.errors, []);
    assert.deepEqual(info.warnings, []);

    const html = fs.readFileSync(path.join(outputPath, 'index.html'), 'utf8');
    const $ = cheerio.load(html, { decodeEntities: false });
    const jsFiles = fs
      .readdirSync(outputPath)
      .filter((name) => name.endsWith('.js'));
    const asyncFile = jsFiles.find(
      (name) => !name.startsWith('main.') && !name.startsWith('runtime.')
    );
    const asyncSri = digest(
      'sha384',
      fs.readFileSync(path.join(outputPath, asyncFile))
    );
    const inlineRuntime = $('script:not([src])')
      .map((_, element) => $(element).html())
      .get()
      .find((body) => body.includes(asyncSri));
    const inlineStyle = $('#real-content-hash-style').html();
    const policy = $('meta[http-equiv="Content-Security-Policy"]').attr(
      'content'
    );
    assert.ok(policy.includes(`'${digest('sha384', inlineRuntime)}'`));
    assert.ok(policy.includes(`'${digest('sha384', inlineStyle)}'`));
    assert.ok(inlineRuntime.includes(asyncSri));
    $('script[src]').each((_, element) => {
      const src = $(element).attr('src');
      assert.equal(
        $(element).attr('integrity'),
        digest('sha384', fs.readFileSync(path.join(outputPath, src)))
      );
    });
    console.log('PASS native RealContentHash + CSP + SRI integration');
  } finally {
    fs.rmSync(outputPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
