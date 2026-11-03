/**
 * Copyright © 2026 BrainEno. 保留所有权利。
 *
 * 本文件及其包含的代码、设计和逻辑均为 BrainEno 的原创作品。
 * 未经作者明确书面授权，禁止复制、修改、分发或用于其他项目。
 *
 * 授权申请：nodeman24@outlook.com
 * 详见：LICENSE, TERMS.md
 */
import type { Language, PortfolioContent } from "../content/types";
import { asset } from "./asset";

/**
 * Canonical origin of the site, baked in at build time.
 *
 * A static host cannot read env vars per request, so `NEXT_PUBLIC_SITE_URL`
 * (or `SITE_URL`) must be set when building for deployment. The host-provided
 * fallbacks are second best — Netlify sets `URL`, GitHub Pages users usually set
 * the variable — and localhost is only for local builds.
 */
export function siteUrl(): URL {
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    process.env.URL || // Netlify
    process.env.DEPLOY_PRIME_URL || // Netlify deploy previews
    process.env.CF_PAGES_URL || // Cloudflare Pages (static)
    "http://localhost:3000";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return new URL("http://localhost:3000");
  }
}

export const htmlLang = (lang: Language) => (lang === "zh" ? "zh-Hans" : "en");

export function pickText(value: { zh: string; en: string } | undefined, lang: Language) {
  return (value?.[lang] || value?.[lang === "zh" ? "en" : "zh"] || "").trim();
}

/**
 * Public absolute URL for a content-owned or site-relative asset (`og:image`,
 * `twitter:image`, JSON-LD `image`).
 *
 * Root-absolute content paths (`/images/...`) are passed through `asset()`
 * first so sub-path deployments (`/<repo>/`) keep their mount prefix instead
 * of resolving against the bare domain root.
 */
export function absoluteUrl(src: string) {
  const base = siteUrl();
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  if (!src) return base.toString();
  try {
    return new URL(asset(src), base).toString();
  } catch {
    return base.toString();
  }
}

export function pageTitle(content: PortfolioContent) {
  const lang = content.identity.defaultLanguage;
  const title = pickText(content.identity.pageTitle, lang) || content.identity.name;
  const site = pickText(content.identity.siteName, lang);
  return site && site !== title ? `${title} — ${site}` : title;
}

/**
 * schema.org dates must be ISO 8601 (`YYYY-MM-DD` or `YYYY`). Content stores
 * repo-era dates as `YYYY.MM.DD` (e.g. `2026.04.22`) for display; normalize
 * those to ISO before they reach JSON-LD so rich results don't drop the field.
 */
export function isoDate(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (iso || /^\d{4}$/.test(value)) return value;
  const dotted = value.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return dotted ? `${dotted[1]}-${dotted[2]}-${dotted[3]}` : value;
}

/** schema.org graph (Person + WebSite + one CreativeWork per project). */
export function jsonLd(content: PortfolioContent) {
  const lang = content.identity.defaultLanguage;
  const origin = siteUrl().toString().replace(/\/$/, "");
  const description = pickText(content.identity.description, lang);
  const sameAs = [content.contact.credit.url].filter((url) => /^https?:\/\//.test(url));
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        url: `${origin}/`,
        name: pickText(content.identity.siteName, lang) || content.identity.name,
        description,
        inLanguage: htmlLang(lang),
      },
      {
        "@type": "Person",
        "@id": `${origin}/#person`,
        name: content.identity.name,
        description,
        url: `${origin}/`,
        // A real portrait photo (~50KB) — not the 1.9MB vertical hero visual
        // (see issue #77): Person.image describes the person, and a heavyweight
        // decorative asset wastes crawler budget.
        image: absoluteUrl(content.intro.portrait.src),
        email: content.contact.email ? `mailto:${content.contact.email}` : undefined,
        sameAs,
      },
      ...content.works.items.map((work) => {
        const workImage = work.image.src || content.hero.image.src;
        return {
          "@type": "CreativeWork",
          "@id": `${origin}/works/${work.id}/`,
          name: pickText(work.title, lang),
          description: pickText(work.description, lang),
          image: workImage ? absoluteUrl(workImage) : undefined,
          url: `${origin}/works/${work.id}/`,
          dateCreated: isoDate(work.year),
          creator: { "@id": `${origin}/#person` },
        };
      }),
    ],
  };
}
