// JSZip is loaded as a classic <script> (vendor/jszip.min.js) before this
// module, exposing a global - it has no ESM build in its published package.
const JSZip = window.JSZip;

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function chapterXhtml(title, text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeXml(p.trim()).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escapeXml(title)}</title></head>\n` +
    `<body><h1>${escapeXml(title)}</h1>\n${paragraphs}\n</body></html>`;
}

// Builds a minimal, valid EPUB2/3-compatible package from translated
// chapters entirely in-browser and returns a Blob ready for download.
export async function buildEpub({ title, author, chapters }) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file('META-INF/container.xml',
    `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
    `  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n` +
    `</container>`);

  const included = chapters.filter((c) => c.translatedText && c.translatedText.trim());
  const manifestItems = included.map((c, i) =>
    `<item id="chap${i}" href="chap${i}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
  const spineItems = included.map((_, i) => `<itemref idref="chap${i}"/>`).join('\n');
  const navPoints = included.map((c, i) =>
    `<navPoint id="navpoint-${i}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel>` +
    `<content src="chap${i}.xhtml"/></navPoint>`).join('\n');
  const navLis = included.map((c, i) =>
    `<li><a href="chap${i}.xhtml">${escapeXml(c.title)}</a></li>`).join('\n');

  const bookId = `urn:uuid:${crypto.randomUUID()}`;

  zip.file('OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">\n` +
    `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `    <dc:identifier id="BookId">${bookId}</dc:identifier>\n` +
    `    <dc:title>${escapeXml(title)}</dc:title>\n` +
    `    <dc:language>en</dc:language>\n` +
    `    <dc:creator>${escapeXml(author || 'Unknown')}</dc:creator>\n` +
    `  </metadata>\n` +
    `  <manifest>\n` +
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n` +
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n` +
    `    ${manifestItems}\n` +
    `  </manifest>\n` +
    `  <spine toc="ncx">\n    ${spineItems}\n  </spine>\n` +
    `</package>`);

  zip.file('OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n` +
    `  <head><meta name="dtb:uid" content="${bookId}"/></head>\n` +
    `  <docTitle><text>${escapeXml(title)}</text></docTitle>\n` +
    `  <navMap>${navPoints}</navMap>\n` +
    `</ncx>`);

  zip.file('OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n` +
    `<head><title>Table of Contents</title></head>\n` +
    `<body><nav epub:type="toc"><h1>Table of Contents</h1><ol>${navLis}</ol></nav></body></html>`);

  included.forEach((c, i) => {
    zip.file(`OEBPS/chap${i}.xhtml`, chapterXhtml(c.title, c.translatedText));
  });

  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
