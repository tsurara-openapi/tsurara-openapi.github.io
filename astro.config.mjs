// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';

// GitHub Pages: the deploy workflow sets these from actions/configure-pages.
const site = process.env.SITE_ORIGIN ?? 'https://tsurara-openapi.github.io';
const base = process.env.SITE_BASE_PATH || '/';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  markdown: {
    processor: satteri({
      features: {
        // `## Heading {#id}`: translations keep the anchors of the English pages, so that links
        // between pages work in every language.
        headingAttributes: true,
        // Keep the quotes of the documentation as written.
        smartPunctuation: false,
      },
    }),
  },
  integrations: [
    starlight({
      title: 'tsurara',
      description:
        'Types and one call function per operation from OpenAPI, for TypeScript, Python, Rust and Go.',
      logo: { src: './src/assets/logo.svg', alt: '' },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/tsurara-openapi/tsurara' }],
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'link',
          attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: `${base.replace(/\/$/, '')}/llms.txt` },
        },
      ],
      sidebar: [
        { label: 'Getting started', translations: { ja: 'はじめに', 'zh-CN': '入门' }, slug: 'getting-started' },
        {
          label: 'TypeScript',
          items: [
            'guide/configuration',
            'guide/types',
            'guide/client',
            'guide/validation',
            'guide/react',
            'guide/mocks',
            'guide/monorepo',
          ],
        },
        {
          label: 'Other languages',
          translations: { ja: 'ほかの言語', 'zh-CN': '其他语言' },
          items: ['languages/python', 'languages/rust', 'languages/go', 'guide/backends'],
        },
        {
          label: 'Tools',
          translations: { ja: 'ツール', 'zh-CN': '工具' },
          items: ['guide/cli', 'guide/ai', 'guide/plugins'],
        },
        { label: 'Design', translations: { ja: '設計', 'zh-CN': '设计' }, slug: 'design' },
      ],
    }),
  ],
});
