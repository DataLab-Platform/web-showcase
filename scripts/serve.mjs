#!/usr/bin/env node
/**
 * Tiny static server putting the showcase host page and DataLab Web under
 * the same origin, as on datalab-platform.com:
 *
 *   /web-showcase/  ->  the host page build (default: ./dist)
 *   /web/           ->  a DataLab Web build (default: $DATALAB_WEB_DIST or
 *                       ./.datalab-web/dist)
 *
 * Usage:
 *   node scripts/serve.mjs [--port 4190] [--host-dist dist]
 *                          [--web-dist ../DataLab-Web/dist]
 *
 * Then open http://localhost:4190/web-showcase/?loop=1
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".woff2": "font/woff2",
};

function parseArgs(argv) {
  const args = {
    port: Number(process.env.PORT) || 4190,
    hostDist: "dist",
    webDist: process.env.DATALAB_WEB_DIST || ".datalab-web/dist",
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--port") args.port = Number(value());
    else if (flag === "--host-dist") args.hostDist = value();
    else if (flag === "--web-dist") args.webDist = value();
    else if (flag === "--help" || flag === "-h") {
      console.log(
        "node scripts/serve.mjs [--port 4190] [--host-dist dist] [--web-dist <DataLab Web dist>]",
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const mounts = [
  { prefix: "/web-showcase/", root: resolve(args.hostDist) },
  { prefix: "/web/", root: resolve(args.webDist) },
];
for (const { prefix, root } of mounts) {
  if (!existsSync(join(root, "index.html"))) {
    console.error(
      `[serve] ${prefix} -> ${root}: no index.html (build it first)`,
    );
    process.exit(1);
  }
}

/** What to answer for ``pathname`` (``null`` when outside every mount). */
function resolveFile(pathname) {
  for (const { prefix, root } of mounts) {
    if (pathname === prefix.slice(0, -1)) return { redirect: prefix };
    if (!pathname.startsWith(prefix)) continue;
    const relative = normalize(
      decodeURIComponent(pathname.slice(prefix.length)),
    );
    const file = join(root, relative);
    if (file !== root && !file.startsWith(root + sep)) return null;
    if (existsSync(file) && statSync(file).isDirectory()) {
      return { file: join(file, "index.html") };
    }
    return { file };
  }
  return null;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/") {
    response.writeHead(302, { Location: `/web-showcase/${url.search}` });
    response.end();
    return;
  }
  const target = resolveFile(url.pathname);
  if (target?.redirect) {
    response.writeHead(301, { Location: `${target.redirect}${url.search}` });
    response.end();
    return;
  }
  if (!target || !existsSync(target.file) || !statSync(target.file).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Not found: ${url.pathname}`);
    return;
  }
  const type =
    MIME_TYPES[extname(target.file).toLowerCase()] ??
    "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": statSync(target.file).size,
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(target.file).pipe(response);
});

server.listen(args.port, () => {
  console.log(`[serve] http://localhost:${args.port}/web-showcase/`);
  for (const { prefix, root } of mounts) {
    console.log(`[serve]   ${prefix} -> ${root}`);
  }
});
