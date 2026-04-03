/* global Defuddle */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "extract-page") {
    return;
  }

  extractPagePayload()
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Page extraction failed."
      });
    });

  return true;
});

async function extractPagePayload() {
  const extracted = extractWithDefuddle();
  const metadata = collectMetadata(extracted);
  const articleRoot = createArticleRoot(extracted.content, metadata.title);
  const sections = buildSections(articleRoot, metadata);
  const chapterXhtml = sections[0]?.contentXhtml || serializeSection({
    nodes: getSectionNodes(articleRoot),
    metadata,
    title: metadata.title,
    includeByline: true
  });

  return {
    title: metadata.title,
    author: metadata.author,
    description: metadata.description,
    language: metadata.language,
    coverImageUrl: metadata.coverImageUrl,
    sourceUrl: window.location.href,
    sections,
    chapterXhtml
  };
}

function extractWithDefuddle() {
  if (typeof Defuddle !== "function") {
    throw new Error("Extractor library failed to load.");
  }

  const parser = new DOMParser();
  const snapshot = parser.parseFromString(document.documentElement.outerHTML, "text/html");
  Object.defineProperty(snapshot, "URL", {
    value: window.location.href,
    configurable: true
  });

  const defuddle = new Defuddle(snapshot, {
    url: window.location.href,
    useAsync: false
  });

  return defuddle.parse();
}

function collectMetadata(extracted) {
  const title = collapseWhitespace(
    extracted?.title ||
    readMeta('meta[property="og:title"]') ||
    readMeta('meta[name="twitter:title"]') ||
    document.title ||
    "Untitled page"
  );

  const author = collapseWhitespace(
    extracted?.author ||
    readMeta('meta[name="author"]') ||
    readMeta('meta[property="article:author"]') ||
    document.querySelector('[rel="author"]')?.textContent ||
    ""
  );

  const description = collapseWhitespace(
    extracted?.description ||
    readMeta('meta[name="description"]') ||
    readMeta('meta[property="og:description"]') ||
    ""
  );

  const coverImageUrl = findCoverImageUrl(extracted);
  const language = sanitizeLanguage(
    extracted?.language ||
    document.documentElement.lang ||
    "en"
  );

  return {
    title: title || "Untitled page",
    author,
    description,
    coverImageUrl,
    language
  };
}

function createArticleRoot(contentHtml, title) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(contentHtml || "", "text/html");
  const root = doc.body;

  absolutizeUrls(root, window.location.href);
  cleanExtractedContent(root);
  ensureTitleHeading(root, title);

  return root;
}

function readMeta(selector) {
  const element = document.querySelector(selector);
  return element?.getAttribute("content")?.trim() || "";
}

function findCoverImageUrl(extracted) {
  const candidates = [
    extracted?.image || "",
    readMeta('meta[property="og:image"]'),
    readMeta('meta[name="twitter:image"]'),
    readMeta('meta[name="twitter:image:src"]'),
    document.querySelector("article img, main img, [role='main'] img")?.getAttribute("src") || "",
    document.querySelector("img")?.getAttribute("src") || ""
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const absolute = new URL(candidate, window.location.href).href;
      if (/^https?:/i.test(absolute)) {
        return absolute;
      }
    } catch {
      continue;
    }
  }

  return "";
}

function cleanExtractedContent(root) {
  for (const element of root.querySelectorAll("script, style, noscript, template")) {
    element.remove();
  }

  for (const element of root.querySelectorAll("*")) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    if (isProbablyUiElement(element)) {
      element.remove();
      continue;
    }

    cleanAttributes(element);
  }
}

function isProbablyUiElement(element) {
  const marker = [element.className, element.id, element.getAttribute("role")]
    .filter(Boolean)
    .join(" ");

  if (/(comment|footer|header|menu|nav|pagination|related|share|sidebar|social|subscribe|toolbar|button-row)/i.test(marker)) {
    return true;
  }

  return ["button", "input", "select", "textarea"].includes(element.tagName.toLowerCase());
}

function cleanAttributes(element) {
  const tagName = element.tagName.toLowerCase();
  const allowedAttrs = new Set(["title", "lang", "id"]);

  if (tagName === "a") {
    allowedAttrs.add("href");
  }

  if (tagName === "img") {
    allowedAttrs.add("src");
    allowedAttrs.add("alt");
    allowedAttrs.add("width");
    allowedAttrs.add("height");
    allowedAttrs.add("srcset");
  }

  if (["td", "th"].includes(tagName)) {
    allowedAttrs.add("colspan");
    allowedAttrs.add("rowspan");
    allowedAttrs.add("scope");
  }

  const attrs = Array.from(element.attributes);
  for (const attr of attrs) {
    if (!allowedAttrs.has(attr.name.toLowerCase())) {
      element.removeAttribute(attr.name);
    }
  }
}

function absolutizeUrls(root, baseUrl) {
  for (const link of root.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) {
      link.removeAttribute("href");
      continue;
    }

    try {
      link.setAttribute("href", new URL(href, baseUrl).href);
    } catch {
      link.removeAttribute("href");
    }
  }

  for (const image of root.querySelectorAll("img")) {
    const src = image.getAttribute("src") || image.getAttribute("data-src");
    if (!src) {
      continue;
    }

    try {
      image.setAttribute("src", new URL(src, baseUrl).href);
    } catch {
      image.removeAttribute("src");
    }

    if (image.hasAttribute("srcset")) {
      image.removeAttribute("srcset");
    }
  }
}

function ensureTitleHeading(root, title) {
  const firstHeading = root.querySelector("h1, h2");
  if (firstHeading) {
    return;
  }

  const heading = root.ownerDocument.createElement("h1");
  heading.textContent = title || document.title || "Untitled page";
  root.prepend(heading);
}

function buildSections(contentRoot, metadata) {
  const container = normalizeSectionContainer(contentRoot);
  const childNodes = getSectionNodes(container);
  const splitLevel = determineSplitLevel(container);

  if (!splitLevel || !childNodes.some((node) => isHeadingNode(node, splitLevel))) {
    return [{
      id: "section-001",
      title: metadata.title,
      contentXhtml: serializeSection({
        nodes: childNodes,
        metadata,
        title: metadata.title,
        includeByline: true
      })
    }];
  }

  const sections = [];
  let currentNodes = [];
  let currentTitle = "Introduction";

  for (const node of childNodes) {
    if (isHeadingNode(node, splitLevel)) {
      pushSection();
      currentNodes = [node.cloneNode(true)];
      currentTitle = collapseWhitespace(node.textContent || metadata.title) || metadata.title;
      continue;
    }

    currentNodes.push(node.cloneNode(true));
  }

  pushSection(true);

  if (!sections.length) {
    return [{
      id: "section-001",
      title: metadata.title,
      contentXhtml: serializeSection({
        nodes: childNodes,
        metadata,
        title: metadata.title,
        includeByline: true
      })
    }];
  }

  return sections.map((section, index) => ({
    ...section,
    id: `section-${String(index + 1).padStart(3, "0")}-${makeSlug(section.title || "section")}`
  }));

  function pushSection(force = false) {
    if (!currentNodes.length) {
      return;
    }

    if (!force && !hasSubstantiveContent(currentNodes)) {
      currentNodes = [];
      return;
    }

    const includeByline = sections.length === 0;
    sections.push({
      title: currentTitle,
      contentXhtml: serializeSection({
        nodes: currentNodes,
        metadata,
        title: currentTitle,
        includeByline
      })
    });
    currentNodes = [];
  }
}

function normalizeSectionContainer(root) {
  let current = root;

  for (let depth = 0; depth < 4; depth += 1) {
    const structuralChildren = Array.from(current.children).filter((child) => {
      return /^(article|div|main|section)$/i.test(child.tagName);
    });

    const nonWhitespaceTextNodes = Array.from(current.childNodes).filter((node) => {
      return node.nodeType === Node.TEXT_NODE && collapseWhitespace(node.textContent || "");
    });

    if (structuralChildren.length !== 1 || nonWhitespaceTextNodes.length) {
      break;
    }

    const onlyChild = structuralChildren[0];
    if (!onlyChild.querySelector("h2, h3, h4")) {
      break;
    }

    current = onlyChild;
  }

  return current;
}

function getSectionNodes(root) {
  return Array.from(root.childNodes).filter((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return collapseWhitespace(node.textContent || "").length > 0;
    }

    return true;
  });
}

function determineSplitLevel(root) {
  const directHeadings = Array.from(root.children).filter((child) => /^H[2-4]$/.test(child.tagName));

  for (const level of [2, 3, 4]) {
    const count = directHeadings.filter((heading) => getHeadingLevel(heading) === level).length;
    if (count >= 2) {
      return level;
    }
  }

  return 0;
}

function isHeadingNode(node, level) {
  return node instanceof HTMLElement && getHeadingLevel(node) === level;
}

function getHeadingLevel(element) {
  const match = element.tagName.match(/^H([1-6])$/i);
  return match ? Number(match[1]) : 0;
}

function hasSubstantiveContent(nodes) {
  const text = collapseWhitespace(nodes.map((node) => node.textContent || "").join(" "));
  if (text.length >= 120) {
    return true;
  }

  return nodes.some((node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    return Boolean(node.querySelector("p, img, ul, ol, table, blockquote, pre, figure"));
  });
}

function serializeSection({ nodes, metadata, title, includeByline }) {
  const xhtmlDoc = document.implementation.createDocument("http://www.w3.org/1999/xhtml", "html", null);
  const html = xhtmlDoc.documentElement;
  html.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  html.setAttribute("xml:lang", metadata.language);
  html.setAttribute("lang", metadata.language);

  const head = xhtmlDoc.createElement("head");
  const titleElement = xhtmlDoc.createElement("title");
  titleElement.textContent = title || metadata.title;
  head.appendChild(titleElement);

  const metaCharset = xhtmlDoc.createElement("meta");
  metaCharset.setAttribute("charset", "utf-8");
  head.appendChild(metaCharset);

  const link = xhtmlDoc.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("type", "text/css");
  link.setAttribute("href", "../styles/book.css");
  head.appendChild(link);

  const body = xhtmlDoc.createElement("body");
  const article = xhtmlDoc.createElement("article");
  article.setAttribute("class", "chapter");

  if (includeByline && metadata.author) {
    const byline = xhtmlDoc.createElement("p");
    byline.setAttribute("class", "byline");
    byline.textContent = `By ${metadata.author}`;
    article.appendChild(byline);
  }

  for (const node of nodes) {
    article.appendChild(xhtmlDoc.importNode(node, true));
  }

  body.appendChild(article);
  html.appendChild(head);
  html.appendChild(body);

  return new XMLSerializer().serializeToString(xhtmlDoc);
}

function makeSlug(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function sanitizeLanguage(value) {
  const normalized = String(value || "").trim();
  return /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/i.test(normalized) ? normalized : "en";
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
