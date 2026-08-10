import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guideRoot = join(projectRoot, "docs", "user-guide");
const configPath = join(guideRoot, "guide.config.json");
const templatePath = join(guideRoot, "template.html");
const outputPath = join(guideRoot, "index.html");
const checkOnly = process.argv.includes("--check");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSafeLinkHref(href) {
  const value = String(href).trim();
  if (/[\u0000-\u001f\u007f\\"']/.test(value) || value.startsWith("//")) return false;
  if (/^(https?:\/\/|mailto:)/i.test(value)) return true;
  return /^(?:#|\.\/)?[a-zA-Z0-9][a-zA-Z0-9._/?#=%-]*$/.test(value) && !value.split(/[?#]/, 1)[0].split("/").includes("..");
}

function isSafeImageHref(href) {
  const value = String(href).trim();
  return /^assets\/[a-zA-Z0-9._/-]+$/.test(value) && !value.split("/").includes("..");
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!isSafeLinkHref(href)) return text;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${titleAttribute}>${text}</a>`;
    },
    image({ href, title, text }) {
      if (!isSafeImageHref(href)) return escapeHtml(text);
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttribute}>`;
    }
  }
});

const unsafeUrlProbe = marked.parseInline("[unsafe](javascript:alert(1)) ![unsafe](javascript:alert(1))");
if (/javascript:/i.test(unsafeUrlProbe)) throw new Error("Markdown URL safety policy is not active");

function renderMarkdown(markdown, sourceName) {
  const directiveBlocks = [];
  const withPlaceholders = markdown.replace(/^:::\s+(screenshot|steps|notice)\s*\r?\n([\s\S]*?)^:::\s*$/gm, (_match, kind, body) => {
    const trimmed = body.trim();
    let renderedBlock;
    if (kind === "notice") {
      renderedBlock = `<div class="notice">${marked.parse(trimmed).trim()}</div>`;
    } else if (kind === "steps") {
      const rendered = marked.parse(trimmed).trim();
      if (!/^<(ol|ul)>/.test(rendered)) {
        throw new Error(`${sourceName}: steps directive must contain a Markdown list`);
      }
      renderedBlock = rendered.replace(/^<(ol|ul)>/, "<$1 class=\"sequence\">");
    } else {
      const fields = {};
      for (const line of trimmed.split(/\r?\n/)) {
        const separator = line.indexOf(":");
        if (separator < 1) throw new Error(`${sourceName}: invalid screenshot field: ${line}`);
        fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      for (const required of ["src", "alt", "badge", "caption"]) {
        if (!fields[required]) throw new Error(`${sourceName}: screenshot is missing ${required}`);
      }
      if (!/^assets\/[a-zA-Z0-9._/-]+$/.test(fields.src) || fields.src.includes("..")) {
        throw new Error(`${sourceName}: screenshot src must stay under assets/`);
      }
      renderedBlock = `<figure><img src="${escapeHtml(fields.src)}" alt="${escapeHtml(fields.alt)}"><figcaption><span class="verified">${escapeHtml(fields.badge)}</span> ${marked.parseInline(fields.caption)}</figcaption></figure>`;
    }
    const placeholder = `GUIDEDIRECTIVEBLOCK${directiveBlocks.length}`;
    directiveBlocks.push(renderedBlock);
    return `\n\n${placeholder}\n\n`;
  });
  let rendered = marked.parse(withPlaceholders).trim();
  directiveBlocks.forEach((block, index) => {
    const placeholder = `<p>GUIDEDIRECTIVEBLOCK${index}</p>`;
    if (!rendered.includes(placeholder)) throw new Error(`${sourceName}: directive placeholder was not rendered safely`);
    rendered = rendered.replace(placeholder, block);
  });
  return rendered;
}

function replaceToken(template, token, value) {
  const marker = `{{${token}}}`;
  if (!template.includes(marker)) throw new Error(`Template token ${marker} is missing`);
  return template.replace(marker, value);
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const template = await readFile(templatePath, "utf8");
if (!Array.isArray(config.sections) || config.sections.length === 0) {
  throw new Error("guide.config.json must define at least one section");
}

const seenIds = new Set();
const renderedSections = [];
const contentRoot = join(guideRoot, "content");
for (const section of config.sections) {
  if (!/^[a-z][a-z0-9-]*$/.test(section.id) || seenIds.has(section.id)) {
    throw new Error(`Invalid or duplicate section id: ${section.id}`);
  }
  seenIds.add(section.id);
  if (typeof section.file !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(section.file)) {
    throw new Error(`Invalid section file: ${section.file}`);
  }
  const sourcePath = resolve(contentRoot, section.file);
  if (dirname(sourcePath) !== contentRoot) throw new Error(`Section file must stay directly under content/: ${section.file}`);
  const markdown = await readFile(sourcePath, "utf8");
  const html = renderMarkdown(markdown, section.file);
  renderedSections.push(`    <section aria-labelledby="${escapeHtml(section.id)}"><h2 id="${escapeHtml(section.id)}" class="purpose">${escapeHtml(section.title)}</h2>\n${html}\n    </section>`);
}

const toc = config.sections
  .map((section) => `      <li><a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`)
  .join("\n");
const badges = config.badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("");

let output = template;
for (const [token, value] of Object.entries({
  TITLE: escapeHtml(config.title),
  PRODUCT_NAME: escapeHtml(config.productName),
  GUIDE_LABEL: escapeHtml(config.guideLabel),
  EYEBROW: escapeHtml(config.eyebrow),
  HEADING: escapeHtml(config.heading),
  DESCRIPTION: escapeHtml(config.description),
  BADGES: badges,
  TOC: toc,
  CONTENT: renderedSections.join("\n\n")
})) {
  output = replaceToken(output, token, value);
}
output = `<!-- Generated by npm run guide:build. Edit content/*.md, guide.config.json, template.html, or assets instead. -->\n${output}`;
if (/{{[A-Z_]+}}/.test(output)) throw new Error("Generated HTML still contains unresolved template tokens");

const assetSources = [...new Set([...output.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)].map((match) => match[1]))];
for (const source of assetSources) {
  await readFile(join(guideRoot, source));
}
const ids = [...output.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length > 0) throw new Error(`Generated HTML has duplicate ids: ${[...new Set(duplicateIds)].join(", ")}`);
const localAnchors = [...output.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
const brokenAnchors = localAnchors.filter((anchor) => !ids.includes(anchor));
if (brokenAnchors.length > 0) throw new Error(`Generated HTML has broken anchors: ${brokenAnchors.join(", ")}`);
if (/^:::\s|^#{1,6}\s/m.test(output)) throw new Error("Generated HTML contains unrendered Markdown or directives");

if (checkOnly) {
  const current = await readFile(outputPath, "utf8");
  if (current !== output) {
    throw new Error("docs/user-guide/index.html is stale; run npm run guide:build");
  }
  console.log(`[guide] checked ${config.sections.length} sections, ${assetSources.length} assets, and ${localAnchors.length} anchors`);
} else {
  await writeFile(outputPath, output, "utf8");
  console.log(`[guide] built ${outputPath} from ${config.sections.length} Markdown sections`);
}
