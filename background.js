chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "convert-tab-to-epub") {
    return;
  }

  convertTabToEpub(message.tabId)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "EPUB creation failed."
      });
    });

  return true;
});

async function convertTabToEpub(tabId) {
  const tab = await chrome.tabs.get(tabId);

  if (!tab?.id) {
    throw new Error("The selected tab is no longer available.");
  }

  if (!tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error("Only regular web pages can be converted.");
  }

  const extraction = await extractPageFromTab(tab.id);
  if (!extraction?.ok || !extraction.payload) {
    throw new Error(extraction?.error || "Could not extract page content.");
  }

  const epubBlob = await buildEpub(extraction.payload);
  const filename = `${safeFileName(extraction.payload.title || "page")}.epub`;
  const url = await blobToDataUrl(epubBlob);

  await chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });

  return { filename };
}

async function extractPageFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "extract-page" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingReceiver = /Receiving end does not exist|Could not establish connection/i.test(message);

    if (!missingReceiver) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["defuddle.js", "content.js"]
    });

    return chrome.tabs.sendMessage(tabId, { type: "extract-page" });
  }
}

async function buildEpub(payload) {
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const identifier = `urn:uuid:${crypto.randomUUID()}`;
  const language = sanitizeLanguage(payload.language);
  const title = payload.title || "Untitled page";
  const author = payload.author || "";
  const description = payload.description || "";
  const coverImage = payload.coverImageUrl ? await fetchNamedImage(payload.coverImageUrl, "cover", "cover") : null;
  const sourceSections = normalizeSections(payload);
  const embeddedSections = [];
  let nextImageIndex = 1;

  for (let index = 0; index < sourceSections.length; index += 1) {
    const section = sourceSections[index];
    const embedded = await embedImages(section.contentXhtml || "", nextImageIndex);
    nextImageIndex = embedded.nextImageIndex;

    embeddedSections.push({
      id: `section-${String(index + 1).padStart(3, "0")}`,
      title: section.title || `Section ${index + 1}`,
      href: `text/section-${String(index + 1).padStart(3, "0")}.xhtml`,
      path: `OEBPS/text/section-${String(index + 1).padStart(3, "0")}.xhtml`,
      contentXhtml: embedded.contentXhtml,
      images: embedded.images
    });
  }

  const allImages = embeddedSections.flatMap((section) => section.images);
  const stylesheet = makeStylesheet();
  const navXhtml = makeNavDocument(title, language, embeddedSections);
  const coverXhtml = coverImage ? makeCoverDocument(title, author, language, coverImage) : "";
  const opf = makePackageDocument({
    identifier,
    title,
    author,
    language,
    description,
    modified,
    coverImage,
    images: allImages,
    sections: embeddedSections
  });

  const files = [
    { path: "mimetype", data: "application/epub+zip", compression: 0 },
    {
      path: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    },
    { path: "OEBPS/content.opf", data: opf },
    { path: "OEBPS/nav.xhtml", data: navXhtml },
    { path: "OEBPS/styles/book.css", data: stylesheet },
    ...(coverImage ? [{ path: "OEBPS/text/cover.xhtml", data: coverXhtml }] : []),
    ...embeddedSections.map((section) => ({
      path: section.path,
      data: section.contentXhtml
    })),
    ...(coverImage ? [{ path: coverImage.path, data: coverImage.data }] : []),
    ...allImages.map((image) => ({
      path: image.path,
      data: image.data
    }))
  ];

  return createZip(files);
}

function normalizeSections(payload) {
  if (Array.isArray(payload.sections) && payload.sections.length) {
    return payload.sections.filter((section) => section?.contentXhtml);
  }

  return [{
    id: "section-001",
    title: payload.title || "Article",
    contentXhtml: payload.chapterXhtml || ""
  }];
}

async function embedImages(contentXhtml, startIndex = 1) {
  const matches = Array.from(contentXhtml.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"[^>]*>/gi));
  const images = [];

  if (!matches.length) {
    return { contentXhtml, images, nextImageIndex: startIndex };
  }

  let rewritten = "";
  let lastIndex = 0;
  let nextImageIndex = startIndex;

  for (const match of matches) {
    const wholeTag = match[0];
    const start = match.index ?? 0;
    const src = decodeXmlEntities(match[1]);
    const alt = decodeXmlEntities(extractAttribute(wholeTag, "alt"));

    rewritten += contentXhtml.slice(lastIndex, start);

    let replacement = "";
    if (src.startsWith("data:")) {
      replacement = wholeTag;
    } else if (/^https?:/i.test(src) && images.length < 20) {
      const embedded = await fetchImage(src, nextImageIndex);
      if (embedded) {
        nextImageIndex += 1;
        images.push(embedded);
        replacement = wholeTag.replace(match[1], escapeAttribute(`../${embedded.relativePath}`));
      } else if (alt) {
        replacement = `<p class="image-note">${escapeXml(`[Image omitted: ${alt}]`)}</p>`;
      }
    } else if (alt) {
      replacement = `<p class="image-note">${escapeXml(`[Image omitted: ${alt}]`)}</p>`;
    }

    rewritten += replacement;
    lastIndex = start + wholeTag.length;
  }

  rewritten += contentXhtml.slice(lastIndex);

  return {
    contentXhtml: rewritten,
    images,
    nextImageIndex
  };
}

async function fetchImage(url, index) {
  return fetchNamedImage(url, `image-${index}`, `image-${String(index).padStart(3, "0")}`);
}

async function fetchNamedImage(url, id, baseName) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();
    const mediaType = normalizeImageType(blob.type, url);
    if (!mediaType) {
      return null;
    }

    const data = new Uint8Array(await blob.arrayBuffer());
    const extension = extensionForMediaType(mediaType);
    const fileName = `${baseName}.${extension}`;
    const relativePath = `images/${fileName}`;

    return {
      id,
      path: `OEBPS/${relativePath}`,
      relativePath,
      mediaType,
      data
    };
  } catch {
    return null;
  }
}

function makeStylesheet() {
  return `html, body {
  margin: 0;
  padding: 0;
}

body {
  font-family: Georgia, serif;
  line-height: 1.6;
  color: #1f1b16;
  background: #fffdf8;
}

.cover-page {
  margin: 0;
  padding: 0;
  background:
    linear-gradient(180deg, #f2e6d4, #fffaf3 28%, #efe1ca 100%);
}

.cover-frame {
  min-height: 100vh;
  padding: 2.4em 1.6em 2em;
  text-align: center;
}

.cover-title {
  margin: 0 0 0.3em;
  font-size: 1.8em;
}

.cover-author {
  margin: 0 0 1.2em;
  color: #6a5c49;
  font-size: 1em;
}

.cover-art {
  display: block;
  max-width: 100%;
  max-height: 70vh;
  margin: 0 auto;
  border: 1px solid #d7c5ac;
}

.chapter {
  max-width: 42em;
  margin: 0 auto;
  padding: 2.4em 1.4em 3em;
}

h1, h2, h3, h4, h5, h6 {
  line-height: 1.2;
  margin: 1.2em 0 0.55em;
}

p, ul, ol, blockquote, pre, table, figure {
  margin: 0 0 1em;
}

a {
  color: #8b4f0e;
  text-decoration: underline;
}

img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1.2em auto;
}

blockquote {
  margin-left: 0;
  padding-left: 1em;
  border-left: 3px solid #d7c5ac;
  color: #564d43;
}

pre, code {
  font-family: "Courier New", monospace;
  white-space: pre-wrap;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  padding: 0.4em;
  border: 1px solid #d9cebc;
}

.byline, .image-note {
  color: #6a5c49;
  font-size: 0.95em;
}`;
}

function makeNavDocument(title, language, sections) {
  const navItems = sections
    .map((section) => `        <li><a href="${escapeAttribute(section.href)}">${escapeXml(section.title)}</a></li>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeAttribute(language)}" xml:lang="${escapeAttribute(language)}">
  <head>
    <title>${escapeXml(title)}</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
${navItems}
      </ol>
    </nav>
  </body>
</html>`;
}

function makeCoverDocument(title, author, language, coverImage) {
  const authorLine = author
    ? `    <p class="cover-author">${escapeXml(author)}</p>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeAttribute(language)}" xml:lang="${escapeAttribute(language)}">
  <head>
    <title>Cover</title>
    <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
  </head>
  <body class="cover-page" epub:type="cover">
    <section class="cover-frame">
      <h1 class="cover-title">${escapeXml(title)}</h1>
${authorLine}      <img class="cover-art" src="../${escapeAttribute(coverImage.relativePath)}" alt="${escapeAttribute(title)}"/>
    </section>
  </body>
</html>`;
}

function makePackageDocument({ identifier, title, author, language, description, modified, coverImage, images, sections }) {
  const creator = author || "Unknown author";
  const sectionManifest = sections
    .map((section) => {
      return `    <item id="${escapeAttribute(section.id)}" href="${escapeAttribute(section.href)}" media-type="application/xhtml+xml"/>`;
    })
    .join("\n");
  const sectionSpine = sections
    .map((section) => {
      return `    <itemref idref="${escapeAttribute(section.id)}"/>`;
    })
    .join("\n");
  const imageManifest = images
    .map((image) => {
      return `    <item id="${escapeAttribute(image.id)}" href="${escapeAttribute(image.relativePath)}" media-type="${escapeAttribute(image.mediaType)}"/>`;
    })
    .join("\n");

  const manifestImages = imageManifest ? `\n${imageManifest}` : "";
  const metadataDescription = description
    ? `\n    <dc:description>${escapeXml(description)}</dc:description>`
    : "";
  const coverMeta = coverImage
    ? `\n    <meta name="cover" content="${escapeAttribute(coverImage.id)}"/>`
    : "";
  const coverManifest = coverImage
    ? `\n    <item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>\n    <item id="${escapeAttribute(coverImage.id)}" href="${escapeAttribute(coverImage.relativePath)}" media-type="${escapeAttribute(coverImage.mediaType)}" properties="cover-image"/>`
    : "";
  const spinePrefix = coverImage
    ? `\n    <itemref idref="cover-page"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(language)}</dc:language>
    <dc:creator>${escapeXml(creator)}</dc:creator>${metadataDescription}${coverMeta}
    <meta property="dcterms:modified">${escapeXml(modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${sectionManifest}${coverManifest}
    <item id="css" href="styles/book.css" media-type="text/css"/>${manifestImages}
  </manifest>
  <spine>
${spinePrefix}
${sectionSpine}
  </spine>
</package>`;
}

function sanitizeLanguage(value) {
  return value && /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(value) ? value : "en";
}

function normalizeImageType(contentType, url) {
  const type = (contentType || "").toLowerCase();
  if (["image/jpeg", "image/png", "image/gif", "image/svg+xml"].includes(type)) {
    return type;
  }

  const loweredUrl = url.toLowerCase();
  if (/\.(jpg|jpeg)(?:$|[?#])/.test(loweredUrl)) {
    return "image/jpeg";
  }

  if (/\.(png)(?:$|[?#])/.test(loweredUrl)) {
    return "image/png";
  }

  if (/\.(gif)(?:$|[?#])/.test(loweredUrl)) {
    return "image/gif";
  }

  if (/\.(svg)(?:$|[?#])/.test(loweredUrl)) {
    return "image/svg+xml";
  }

  return "";
}

function extensionForMediaType(mediaType) {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

function safeFileName(value) {
  return (value || "page")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "page";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeAttribute(value) {
  return escapeXml(value);
}

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match ? match[1] : "";
}

function decodeXmlEntities(value) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function createZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const dataBytes = entry.data instanceof Uint8Array ? entry.data : encoder.encode(entry.data);
    const crc = crc32(dataBytes);
    const dosTime = dateToDosTime(new Date());
    const dosDate = dateToDosDate(new Date());

    const localHeader = new ArrayBuffer(30);
    const localView = new DataView(localHeader);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);

    localParts.push(new Uint8Array(localHeader), nameBytes, dataBytes);

    const centralHeader = new ArrayBuffer(46);
    const centralView = new DataView(centralHeader);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);

    centralParts.push(new Uint8Array(centralHeader), nameBytes);
    offset += 30 + nameBytes.length + dataBytes.length;
  }

  const centralDirectory = concatUint8Arrays(centralParts);
  const endRecord = new ArrayBuffer(22);
  const endView = new DataView(endRecord);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const output = concatUint8Arrays([
    ...localParts,
    centralDirectory,
    new Uint8Array(endRecord)
  ]);

  return new Blob([output], { type: "application/epub+zip" });
}

function concatUint8Arrays(parts) {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : new Uint8Array(part)));
  const size = arrays.reduce((sum, item) => sum + item.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;

  for (const item of arrays) {
    merged.set(item, offset);
    offset += item.length;
  }

  return merged;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dateToDosTime(date) {
  return ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
}

function dateToDosDate(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  const mimeType = blob.type || "application/octet-stream";
  return `data:${mimeType};base64,${base64}`;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
