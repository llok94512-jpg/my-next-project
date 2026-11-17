import { createZip } from './zip.js';

const xmlEsc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Build a valid EPUB 3 package (with NCX fallback) for the reflowable reader. */
export function buildEpub({ title, author, chapters, language = 'en' }) {
  const id = `urn:uuid:studyflix-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const chapterFiles = chapters.map((chapter, index) => ({
    id: `ch${index + 1}`,
    href: `chapter${index + 1}.xhtml`,
    title: chapter.title,
    body: chapter.body,
  }));

  const chapterXhtml = (chapter) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}">
<head><meta charset="utf-8" /><title>${xmlEsc(chapter.title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" /></head>
<body><h1>${xmlEsc(chapter.title)}</h1>${chapter.body}</body></html>`;

  const navList = chapterFiles
    .map((c) => `<li><a href="${c.href}">${xmlEsc(c.title)}</a></li>`)
    .join('\n        ');

  const manifest = chapterFiles
    .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml" />`)
    .join('\n    ');

  const spine = chapterFiles.map((c) => `<itemref idref="${c.id}" />`).join('\n    ');

  const ncxPoints = chapterFiles
    .map(
      (c, i) =>
        `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlEsc(c.title)}</text></navLabel><content src="${c.href}" /></navPoint>`,
    )
    .join('\n    ');

  const files = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`,
    },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${id}</dc:identifier>
    <dc:title>${xmlEsc(title)}</dc:title>
    <dc:creator>${xmlEsc(author)}</dc:creator>
    <dc:language>${language}</dc:language>
    <dc:description>STUDYFLIX Reading Corner edition.</dc:description>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="css" href="style.css" media-type="text/css" />
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>`,
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head><meta charset="utf-8" /><title>${xmlEsc(title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
        ${navList}
      </ol></nav></body></html>`,
    },
    {
      name: 'OEBPS/toc.ncx',
      data: `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${id}" /></head>
  <docTitle><text>${xmlEsc(title)}</text></docTitle>
  <navMap>
    ${ncxPoints}
  </navMap>
</ncx>`,
    },
    {
      name: 'OEBPS/style.css',
      data: `body { font-family: Georgia, serif; line-height: 1.6; margin: 6% 8%; color: #14243b; }
h1 { font-size: 1.6em; color: #0b2545; margin-bottom: 0.8em; }
p { margin: 0 0 1em; }
blockquote { border-left: 3px solid #2f6fd0; margin-left: 0; padding-left: 1em; color: #3c4d66; }`,
    },
    ...chapterFiles.map((c) => ({ name: `OEBPS/${c.href}`, data: chapterXhtml(c) })),
  ];

  return createZip(files);
}
