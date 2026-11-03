/**
 * Copyright © 2026 BrainEno. 保留所有权利。
 *
 * 本文件及其包含的代码、设计和逻辑均为 BrainEno 的原创作品。
 * 未经作者明确书面授权，禁止复制、修改、分发或用于其他项目。
 *
 * 授权申请：nodeman24@outlook.com
 * 详见：LICENSE, TERMS.md
 */
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/inria-serif/latin-400.css";
import "@fontsource/inria-serif/latin-400-italic.css";
import "@fontsource/inria-serif/latin-700.css";
import { getSiteContent } from "@/portfolio/content/source";
import { htmlLang, pageTitle, pickText, siteUrl, absoluteUrl } from "@/portfolio/seo/site";
import PwaRegister from "@/portfolio/ui/PwaRegister";
import "./globals.css";

// Fonts are self-hosted from the npm packages above, not fetched from Google:
// the build no longer needs the internet, the files ship with the site, and the
// static export works on any host (including offline / air-gapped previews).

export async function generateMetadata(): Promise<Metadata> {
  const content = await getSiteContent();
  const lang = content.identity.defaultLanguage;
  const title = pageTitle(content);
  const description = pickText(content.identity.description, lang);
  // Dedicated 1200×630 landscape share card (1.91:1, ~30KB). The hero visual is
  // a vertical 1086×1448 PNG (~1.9MB) which social platforms crop heavily for
  // summary_large_image and which some crawlers refuse to fetch at all — ship a
  // purpose-built card instead (see issue #77).
  const image = absoluteUrl("/images/og-card.png");
  return {
    metadataBase: siteUrl(),
    title: { default: title, template: `%s — ${pickText(content.identity.siteName, lang) || content.identity.name}` },
    description,
    applicationName: content.identity.name,
    authors: [{ name: content.identity.name }],
    creator: content.identity.name,
    keywords: [content.identity.name, ...content.works.items.map((w) => pickText(w.title, lang))],
    alternates: { canonical: "/" },
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: content.identity.name, statusBarStyle: "black-translucent" },
    formatDetection: { telephone: false },
    openGraph: {
      type: "website",
      siteName: pickText(content.identity.siteName, lang) || content.identity.name,
      title,
      description,
      url: "/",
      locale: lang === "zh" ? "zh_CN" : "en_US",
      images: [{ url: image, width: 1200, height: 630, alt: pickText(content.identity.description, lang) }],
    },
    twitter: { card: "summary_large_image", title, description, images: [{ url: image, width: 1200, height: 630 }] },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large" } },
  };
}

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const content = await getSiteContent();
  return (
    <html lang={htmlLang(content.identity.defaultLanguage)} suppressHydrationWarning>
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
