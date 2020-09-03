import type * as d from '../declarations';
import type { ServerResponse } from 'http';
import { responseHeaders, getSsrStaticDataPath } from './dev-server-utils';
import { appendDevServerClientScript } from './serve-file';
import { catchError, isFunction, isString } from '@utils';
import path from 'path';

export async function ssrPageRequest(
  devServerConfig: d.DevServerConfig,
  serverCtx: d.DevServerContext,
  req: d.HttpRequest,
  res: ServerResponse,
) {
  try {
    let status = 500;
    let content = '';

    const { hydrateApp, srcIndexHtml, diagnostics } = await setupHydrateApp(devServerConfig, serverCtx);

    if (diagnostics.length === 0) {
      try {
        const opts = getSsrHydrateOptions(devServerConfig, serverCtx, req.url);

        const ssrResults = await hydrateApp.renderToString(srcIndexHtml, opts);

        if (ssrResults.diagnostics.length > 0) {
          diagnostics.push(...ssrResults.diagnostics);
        } else {
          status = ssrResults.httpStatus;
          content = ssrResults.html;
        }
      } catch (e) {
        catchError(diagnostics, e);
      }
    }

    if (diagnostics.length > 0) {
      content = getSsrErrorContent(diagnostics);
    }

    if (devServerConfig.websocket) {
      content = appendDevServerClientScript(devServerConfig, req, content);
    }

    serverCtx.logRequest(req, status);

    res.writeHead(
      status,
      responseHeaders({
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(content, 'utf8'),
      }),
    );
    res.write(content);
    res.end();
  } catch (e) {
    serverCtx.serve500(req, res, e, `ssrPageRequest`);
  }
}

export async function ssrStaticDataRequest(
  devServerConfig: d.DevServerConfig,
  serverCtx: d.DevServerContext,
  req: d.HttpRequest,
  res: ServerResponse,
) {
  try {
    const data: any = {};
    let status = 500;
    let httpCache = false;

    const { hydrateApp, srcIndexHtml, diagnostics } = await setupHydrateApp(devServerConfig, serverCtx);

    if (diagnostics.length === 0) {
      try {
        const { ssrPath, hasQueryString } = getSsrStaticDataPath(req.url.href);
        const url = new URL(ssrPath, req.url);

        const opts = getSsrHydrateOptions(devServerConfig, serverCtx, url);

        const ssrResults = await hydrateApp.renderToString(srcIndexHtml, opts);

        if (ssrResults.diagnostics.length > 0) {
          diagnostics.push(...ssrResults.diagnostics);
        } else {
          ssrResults.staticData.forEach(s => {
            if (s.type === 'application/json') {
              data[s.id] = JSON.parse(s.content);
            } else {
              data[s.id] = s.content;
            }
          });
          data.components = ssrResults.components.map(c => c.tag).sort();
          httpCache = hasQueryString;
          status = 200;
        }
      } catch (e) {
        catchError(diagnostics, e);
      }
    }

    if (diagnostics.length > 0) {
      data.diagnostics = diagnostics;
    }

    const content = JSON.stringify(data);
    serverCtx.logRequest(req, status);

    res.writeHead(
      status,
      responseHeaders(
        {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(content, 'utf8'),
        },
        httpCache,
      ),
    );
    res.write(content);
    res.end();
  } catch (e) {
    serverCtx.serve500(req, res, e, `ssrStaticDataRequest`);
  }
}

async function setupHydrateApp(devServerConfig: d.DevServerConfig, serverCtx: d.DevServerContext) {
  let srcIndexHtml: string = null;
  let hydrateApp: HydrateApp = null;

  const buildResults = await serverCtx.getBuildResults();
  const diagnostics: d.Diagnostic[] = [];

  if (serverCtx.prerenderConfig == null && isString(devServerConfig.prerenderConfig)) {
    const compilerPath = path.join(devServerConfig.devServerDir, '..', 'compiler', 'stencil.js');
    const compiler: typeof import('@stencil/core/compiler') = require(compilerPath);
    const prerenderConfigResults = compiler.nodeRequire(devServerConfig.prerenderConfig);
    diagnostics.push(...prerenderConfigResults.diagnostics);
    if (prerenderConfigResults.module && prerenderConfigResults.module.config) {
      serverCtx.prerenderConfig = prerenderConfigResults.module.config;
    }
  }

  if (!isString(buildResults.hydrateAppFilePath)) {
    diagnostics.push({ messageText: `Missing hydrateAppFilePath`, level: `error`, type: `ssr` });
  } else if (!isString(devServerConfig.srcIndexHtml)) {
    diagnostics.push({ messageText: `Missing srcIndexHtml`, level: `error`, type: `ssr` });
  } else {
    srcIndexHtml = await serverCtx.sys.readFile(devServerConfig.srcIndexHtml);
    if (!isString(srcIndexHtml)) {
      diagnostics.push({
        messageText: `Unable to load src index html: ${devServerConfig.srcIndexHtml}`,
        level: `error`,
        type: `ssr`,
      });
    } else {
      // ensure we cleared out node's internal require() cache for this file
      const hydrateAppFilePath = path.resolve(buildResults.hydrateAppFilePath);
      delete require.cache[hydrateAppFilePath];

      hydrateApp = require(hydrateAppFilePath);
    }
  }

  return {
    hydrateApp,
    srcIndexHtml,
    diagnostics,
  };
}

function getSsrHydrateOptions(devServerConfig: d.DevServerConfig, serverCtx: d.DevServerContext, url: URL) {
  const opts: d.PrerenderHydrateOptions = {
    url: url.href,
    addModulePreloads: false,
    approximateLineWidth: 120,
    inlineExternalStyleSheets: false,
    minifyScriptElements: false,
    minifyStyleElements: false,
    removeAttributeQuotes: false,
    removeBooleanAttributeQuotes: false,
    removeEmptyAttributes: false,
    removeHtmlComments: false,
    prettyHtml: true,
  };

  if (isFunction(serverCtx?.prerenderConfig.hydrateOptions)) {
    const userOpts = serverCtx.prerenderConfig.hydrateOptions(url);
    if (userOpts) {
      Object.assign(opts, userOpts);
    }
  }

  if (isFunction(serverCtx.sys.applyPrerenderGlobalPatch)) {
    const orgBeforeHydrate = opts.beforeHydrate;
    opts.beforeHydrate = (document: Document) => {
      // patch this new window with the fetch global from node-fetch
      const devServerBaseUrl = new URL(devServerConfig.browserUrl);
      const devServerHostUrl = devServerBaseUrl.origin;
      serverCtx.sys.applyPrerenderGlobalPatch({
        devServerHostUrl: devServerHostUrl,
        window: document.defaultView,
      });

      if (typeof orgBeforeHydrate === 'function') {
        return orgBeforeHydrate(document);
      }
    };
  }

  return opts;
}

function getSsrErrorContent(diagnostics: d.Diagnostic[]) {
  return `<!doctype html>
<html>
<head>
  <title>SSR Error</title>
  <style>
    body {
      font-family: Consolas, 'Liberation Mono', Menlo, Courier, monospace !important;
    }
  </style>
</head>
<body>
  <h1>SSR Dev Error</h1>
  ${diagnostics.map(
    diagnostic => `
  <p>
    ${diagnostic.messageText}
  </p>
  `,
  )}
</body>
</html>`;
}

type HydrateApp = {
  renderToString: (html: string, options: d.SerializeDocumentOptions) => Promise<d.HydrateResults>;
};
