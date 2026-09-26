import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6mQAAAAASUVORK5CYII=', 'base64');
export async function writeEpub(filePath, options = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  if (options.encrypted) zip.file('META-INF/encryption.xml', '<encryption/>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="id">
<metadata><dc:identifier id="id">urn:uuid:test-book</dc:identifier><dc:title>山海小书</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language>
${options.fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}
</metadata><manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>目录</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="chapter1.xhtml">第一章</a></li><li><a href="chapter2.xhtml">第二章</a></li></ol></nav></body></html>');
  zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1><p>山海故事开始。寻找星辰。</p><img src="cover.png" alt="封面插图"/><p><a href="chapter2.xhtml">前往第二章</a></p>${options.malicious ? `<script>window.top.hacked=true</script><img src="${options.remoteUrl || 'https://example.com/tracker.png'}"/>` : ''}</body></html>`);
  zip.file('OEBPS/chapter2.xhtml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章</h1><p>星辰落在海面。Star light over the sea.</p></body></html>');
  zip.file('OEBPS/cover.png', png);
  await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return filePath;
}
export async function writePdf(filePath, options = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(options.title ?? 'PDF Sample');
  pdf.setAuthor('PDF Author');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= (options.pages ?? 3); i++) {
    const page = pdf.addPage([460, 650]);
    page.drawRectangle({ x: 0, y: 0, width: 460, height: 650, color: rgb(1, 1, 1) });
    if (!options.scanned) page.drawText(`Searchable page ${i} with a lighthouse.`, { x: 50, y: 550, size: 18, font, color: rgb(0, 0, 0) });
    else page.drawRectangle({ x: 70, y: 200, width: 320, height: 300, color: rgb(0.3, 0.5, 0.7) });
  }
  await writeFile(filePath, await pdf.save());
  return filePath;
}
export async function writeMixedFixtures(dir) {
  const txt = path.join(dir, 'novel.txt');
  const epub = path.join(dir, 'novel.epub');
  const pdf = path.join(dir, 'manual.pdf');
  await writeFile(txt, '一本中文 TXT 小说。\n第二行。');
  await writeEpub(epub);
  await writePdf(pdf);
  return { txt, epub, pdf };
}
