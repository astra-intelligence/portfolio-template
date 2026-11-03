#!/usr/bin/env node
/**
 * Post-build smoke test: boot the exported folder exactly as a static host
 * would and check the things that a `next build` success does not prove.
 *
 *   npm run build:static && npm run smoke
 *
 * It is deliberately browser-free (node's `fetch` against `scripts/preview.mjs`,
 * which has no framework fallbacks) so it can run in CI in a couple of seconds,
 * right before the deploy step, and catch the classic static-hosting
 * regressions:
 *
 *   - a route that only exists because the dev server rewrites URLs
 *   - a 404 that returns 200 (soft 404s poison search results)
 *   - `robots.txt` that leaks the whole site out of the index
 *   - an asset URL that was never exported — including the GitHub Pages
 *     sub-path trap, where `_next/*` is prefixed by the framework but
 *     content-owned paths (`/images/…`, `/gltfs/…`) are not
 *
 * With `NEXT_PUBLIC_BASE_PATH=/repo` the export is mounted under `/repo`, which
 * is what a Pages project site does: anything outside the prefix is a 404.
 *
 * Exit code 1 on any failure, with every problem listed — not just the first.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, process.env.OUT_DIR || "out");
/**
 * `0` lets the OS pick a free port: smoke runs in back-to-back CI steps and a
 * fixed port would collide with the previous run's socket.
 */
const PORT = Number(process.env.SMOKE_PORT ?? 0);
const buildMeta = (() => {
  try {
    return JSON.parse(readFileSync(path.join(OUT, "build-meta.json"), "utf8"));
  } catch {
    return {};
  }
})();

/**
 * `/repo` for a GitHub Pages project site, empty at a domain root. Read from the
 * build itself unless overridden: a prefixed export tested at the root (or the
 * reverse) fails in a way that looks like the site is broken.
 */
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? buildMeta.basePath ?? "").replace(/\/+$/, "");

const SITE_ORIGIN = (() => {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || buildMeta.siteUrl || "http://localhost:3000";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).origin;
  } catch {
    return "http://localhost:3000";
  }
})();

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` (${detail})` : ""}`);
};

if (!existsSync(path.join(OUT, "index.html"))) {
  console.error(`[smoke] no export at ${OUT} — run \`npm run build:static\` first.`);
  process.exit(1);
}

/** Site-absolute path for a route, including the deployment prefix. */
const route = (pathname) => `${BASE_PATH}${pathname}`;

/** Every page in the export, taken from the sitemap the site itself publishes. */
function sitemapPaths() {
  const xml = readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
  return [...xml.matchAll(/<loc>[^<]+<\/loc>/g)].map(([loc]) => {
    const pathname = loc.replace(/<\/?loc>/g, "").replace(/^https?:\/\/[^/]+/, "");
    return pathname || "/";
  });
}

const server = spawn(process.execPath, [path.join(ROOT, "scripts", "preview.mjs")], {
  env: { ...process.env, PORT: String(PORT), OUT_DIR: OUT, MOUNT: BASE_PATH },
  stdio: ["ignore", "pipe", "inherit"],
});

const BASE = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("preview server did not start")), 15000);
  server.stdout.on("data", (chunk) => {
    const match = String(chunk).match(/\[preview\][^→]*→ http:\/\/localhost:(\d+)/);
    if (match) {
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${match[1]}`);
    }
  });
  server.on("exit", (code) => reject(new Error(`preview server exited (${code})`)));
});

const head = (path, method = "GET") => fetch(`${BASE}${path}`, { method, redirect: "manual" });

try {
  console.log(`[smoke] mode: ${BASE_PATH ? `mounted at ${BASE_PATH} (GitHub Pages project site)` : "domain root"}`);

  console.log("[smoke] pages");
  const paths = sitemapPaths();
  check("sitemap lists pages", paths.length > 0, `${paths.length} URLs`);
  check("sitemap URLs sit under the base path", !BASE_PATH || paths.every((p) => p.startsWith(`${BASE_PATH}/`)));
  for (const pathname of paths) {
    const response = await head(pathname);
    const html = response.headers.get("content-type")?.includes("text/html");
    check(`${pathname} → 200 html`, response.status === 200 && Boolean(html), `status ${response.status}`);
  }

  console.log("[smoke] 404s");
  for (const pathname of ["/admin/", "/nope/", "/works/not-a-project/"]) {
    const response = await head(route(pathname));
    check(`${route(pathname)} → 404`, response.status === 404, `status ${response.status}`);
  }
  if (BASE_PATH) {
    // Outside the prefix is somebody else's site on the same origin
    // (`<user>.github.io/<other-repo>/`): it must not be served from here.
    const outside = await head("/images/headline.png");
    check("assets outside the base path are not served", outside.status === 404, `status ${outside.status}`);
  }

  console.log("[smoke] metadata routes");
  const robots = await head(route("/robots.txt"));
  const robotsBody = await robots.text();
  check("robots.txt → 200", robots.status === 200, `status ${robots.status}`);
  check(
    "robots.txt only disallows /offline",
    robotsBody.split("\n").filter((line) => line.startsWith("Disallow:")).length === 1 &&
      /Disallow: .*\/offline/.test(robotsBody),
    robotsBody.match(/^Disallow:.*$/gm)?.join(" ")
  );
  check("robots.txt points at the sitemap", /Sitemap: https?:\/\//.test(robotsBody));
  const manifestResponse = await head(route("/manifest.webmanifest"));
  check("manifest.webmanifest → 200", manifestResponse.status === 200, `status ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  if (BASE_PATH) {
    // An installed PWA with `start_url: "/"` on a project site would open
    // `<user>.github.io` instead of the site.
    check(
      "manifest is scoped to the base path",
      manifest.start_url === `${BASE_PATH}/` && manifest.scope === `${BASE_PATH}/`,
      `start_url ${manifest.start_url}, scope ${manifest.scope}`
    );
    check(
      "manifest icons carry the base path",
      manifest.icons.every((icon) => icon.src.startsWith(`${BASE_PATH}/`)),
      manifest.icons[0]?.src
    );
  }
  const sitemap = await head(route("/sitemap.xml"));
  check("sitemap.xml → 200", sitemap.status === 200, `status ${sitemap.status}`);

  console.log("[smoke] every asset referenced by every page");
  // A missing `srcSet` candidate is silent in the browser (it falls back), but a
  // missing `src` is an empty box — and on a sub-path deployment a forgotten
  // prefix 404s *every* picture while the HTML, CSS and JS all load.
  // `404.html` matters as much as any page: GitHub Pages serves it for every
  // mistyped URL, and its own links must carry the prefix too.
  const pages = [...paths, route("/offline/"), route("/404.html")];
  const urls = new Set();
  for (const pathname of pages) {
    const relative = pathname.slice(BASE_PATH.length).replace(/^\//, "");
    const candidate = path.join(OUT, relative);
    const file = !existsSync(candidate) || statSync(candidate).isDirectory() ? path.join(candidate, "index.html") : candidate;
    if (!existsSync(file)) {
      failures.push(`missing page file for ${pathname}`);
      continue;
    }
    // `<link rel="preconnect" href="/">` points at the *origin*, not at a file;
    // on a project site that is somebody else's root. It is not a fetch.
    const html = readFileSync(file, "utf8").replace(/<link[^>]+rel="(?:preconnect|dns-prefetch)"[^>]*>/g, "");
    const add = (raw) => {
      const url = raw.split("#")[0].split("?")[0];
      // Only site-absolute URLs are this export's business; relative links
      // resolve against the page and external ones leave the origin.
      if (url.startsWith("/")) urls.add(url);
    };
    for (const [, value] of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) add(value);
    for (const [, value] of html.matchAll(/(?:srcSet|imageSrcSet)="([^"]*)"/g)) {
      for (const candidate of value.split(",")) add(candidate.trim().split(" ")[0]);
    }
  }
  let missing = 0;
  for (const url of urls) {
    const response = await head(url, "HEAD");
    if (response.status !== 200) {
      missing += 1;
      console.log(`  FAIL ${url} → ${response.status}`);
      failures.push(`${url} → ${response.status}`);
    }
  }
  check(`every asset referenced by ${pages.length} pages resolves`, missing === 0, `${urls.size} URLs, ${missing} missing`);

  console.log("[smoke] share & structured-data images");
  const collectLdImages = (node, out) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectLdImages(item, out);
      return;
    }
    if ("image" in node && node.image) {
      const val = node.image;
      if (typeof val === "string") out.push(val);
      else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string") out.push(item);
          else if (item && typeof item === "object" && typeof item.url === "string") out.push(item.url);
        }
      } else if (typeof val === "object" && typeof val.url === "string") {
        out.push(val.url);
      }
    }
    for (const value of Object.values(node)) collectLdImages(value, out);
  };

  const shareUrls = new Set();
  let metaMissingPages = 0;
  for (const pathname of paths) {
    const relative = pathname.slice(BASE_PATH.length).replace(/^\/$/, "");
    const candidate = path.join(OUT, relative);
    const file = !existsSync(candidate) || statSync(candidate).isDirectory() ? path.join(candidate, "index.html") : candidate;
    if (!existsSync(file)) continue;
    const html = readFileSync(file, "utf8");

    let hasOg = false;
    let hasTwitter = false;
    for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
      const key = tag.match(/\b(?:property|name)="([^"]+)"/i)?.[1]?.toLowerCase();
      const content = tag.match(/\bcontent="([^"]+)"/i)?.[1];
      if (!content) continue;
      if (key === "og:image") {
        hasOg = true;
        shareUrls.add(content);
      } else if (key === "twitter:image") {
        hasTwitter = true;
        shareUrls.add(content);
      }
    }
    if (!hasOg || !hasTwitter) {
      metaMissingPages += 1;
      failures.push(`${pathname} missing ${!hasOg ? "og:image" : "twitter:image"}`);
    }

    for (const [, rawJson] of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const ldUrls = [];
        collectLdImages(JSON.parse(rawJson), ldUrls);
        for (const url of ldUrls) shareUrls.add(url);
      } catch (err) {
        failures.push(`${pathname} invalid JSON-LD (${err.message})`);
      }
    }
  }
  check("every crawlable page emits og:image and twitter:image", metaMissingPages === 0, `${paths.length} pages`);

  // Issue #77: the share card must be a purpose-built 1.91:1 landscape image,
  // not a heavy vertical hero PNG that platforms crop (and crawlers may refuse).
  // Home og:image -> /images/og-card.png, whose exported PNG is 1200x630 and
  // comfortably under 200KB. Per-page cards fall back to the same card.
  const homeFile = existsSync(path.join(OUT, "index.html"))
    ? path.join(OUT, "index.html")
    : path.join(OUT, BASE_PATH.slice(1), "index.html");
  try {
    const homeHtml = readFileSync(homeFile, "utf8");
    const ogImage = homeHtml.match(/<meta\b[^>]*property="og:image"[^>]*content="([^"]+)"/i)?.[1];
    if (!ogImage) {
      failures.push("home og:image missing");
    } else {
      shareUrls.add(ogImage);
      const ogPath = ogImage.replace(/^https?:\/\/[^/]+/, "");
      const ogRel = ogPath.slice(BASE_PATH.length).replace(/^\//, "");
      const ogFile = path.join(OUT, ogRel);
      if (!existsSync(ogFile)) {
        failures.push(`home og:image ${ogImage} not exported`);
      } else if (ogFile.endsWith(".png")) {
        const raw = readFileSync(ogFile);
        const [w, h] = [raw.readUInt32BE(16), raw.readUInt32BE(20)];
        const kb = raw.length / 1024;
        if (w !== 1200 || h !== 630)
          failures.push(`home og:image is ${w}x${h}, expected 1200x630 (1.91:1 for summary_large_image)`);
        if (kb > 200) failures.push(`home og:image is ${kb.toFixed(0)}KB (>200KB crawler budget)`);
      }
    }
  } catch (err) {
    failures.push(`home og:image check failed (${err.message})`);
  }

  let badShare = 0;
  for (const rawUrl of shareUrls) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      badShare += 1;
      console.log(`  FAIL invalid share image URL: ${rawUrl}`);
      failures.push(`invalid share image URL: ${rawUrl}`);
      continue;
    }
    if (parsed.origin !== SITE_ORIGIN) continue;
    if (BASE_PATH && !parsed.pathname.startsWith(`${BASE_PATH}/`)) {
      badShare += 1;
      console.log(`  FAIL ${rawUrl} missing base path ${BASE_PATH}`);
      failures.push(`${rawUrl} missing base path ${BASE_PATH}`);
      continue;
    }
    const response = await head(parsed.pathname, "HEAD");
    if (response.status !== 200) {
      badShare += 1;
      console.log(`  FAIL ${rawUrl} → ${response.status}`);
      failures.push(`${rawUrl} → ${response.status}`);
    }
  }
  check(
    "every same-origin og/twitter/JSON-LD image carries base path and resolves",
    badShare === 0 && shareUrls.size > 0,
    `${shareUrls.size} URLs, ${badShare} broken`
  );

  console.log("[smoke] transfer encoding");
  const compressed = await fetch(`${BASE}${route("/")}`, { headers: { "accept-encoding": "br" } });
  check(
    "html is served brotli-encoded for br clients",
    compressed.headers.get("content-encoding") === "br",
    compressed.headers.get("content-encoding") ?? "identity"
  );
} finally {
  server.kill();
}

console.log(failures.length ? `\n[smoke] ${failures.length} failure(s)` : "\n[smoke] all checks passed");
process.exit(failures.length ? 1 : 0);
