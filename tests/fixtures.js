// Shared binary fixtures for tests that need a real PDF or EPUB (mcpReader's
// extraction, and the MCP tools that read through it). Synthesized rather than
// checked in: a few hundred bytes of readable source beats an opaque blob, and the
// repo keeps no fixture directory.
import AdmZip from 'adm-zip';

/**
 * A valid, uncompressed, multi-page PDF with one Helvetica text stream per page and
 * a correct xref table — small, but parsed by pdfjs exactly like a real book.
 * @param {string[][]} pages - lines of text per page.
 * @returns {Buffer}
 */
export function buildPdf(pages) {
    const fontNum = 2 + pages.length * 2 + 1;
    const bodies = [];
    const pageNums = [];

    bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    pages.forEach((lines, i) => {
        const pageNum = 3 + i * 2;
        const contentNum = pageNum + 1;
        pageNums.push(pageNum);
        const stream = [
            'BT', '/F1 24 Tf', '72 700 Td',
            ...lines.flatMap((l, n) => (n === 0 ? [`(${l}) Tj`] : ['0 -30 Td', `(${l}) Tj`])),
            'ET',
        ].join('\n');
        bodies[pageNum - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
            + `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`;
        bodies[contentNum - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    bodies[1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    bodies[fontNum - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    bodies.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
}

/**
 * The smallest thing a decoder will accept as a PNG: a 1×1 image, with a real
 * signature, IHDR, IDAT and IEND. `tint` changes the pixel byte (and with it the
 * checksums), so two fixtures differ in content while staying the same length — which
 * is what lets a test assert it got *this* image back rather than some other one.
 * @param {number} [tint=0]
 * @returns {Buffer}
 */
export function buildPng(tint = 0) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);   // width
    ihdr.writeUInt32BE(1, 4);   // height
    ihdr[8] = 8;                // 8-bit
    ihdr[9] = 2;                // truecolour
    // One scanline: a filter byte then RGB. zlib-stored (uncompressed) so no deflate
    // is needed here — a fixture should be readable, not clever.
    const raw = Buffer.from([0, tint & 0xff, 0, 0]);
    const adler = (b) => {
        let a = 1, s = 0;
        for (const byte of b) { a = (a + byte) % 65521; s = (s + a) % 65521; }
        return ((s << 16) | a) >>> 0;
    };
    const sum = Buffer.alloc(4); sum.writeUInt32BE(adler(raw));
    const len = Buffer.alloc(4); len.writeUInt16LE(raw.length, 0); len.writeUInt16LE(~raw.length & 0xffff, 2);
    const idat = Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.from([0x01]), len, raw, sum]);

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * An EPUB with the full container.xml → OPF → spine chain mcpReader walks.
 *
 * `images` is optional and backward-compatible: without it this builds exactly the
 * text-only book the extraction tests have always used. With it, each entry becomes
 * a manifest item AND a real zip entry, so image listing and byte reads can both be
 * exercised. Chapter bodies reference them with ordinary relative `<img src>`, since
 * that is what the resolver has to cope with.
 *
 * @param {{href: string, title: string, body: string}[]} chapters - body is XHTML.
 * @param {{href: string, data?: Buffer, mediaType?: string, cover?: boolean}[]} [images]
 *   `href` is relative to OEBPS/, matching how chapters reference it.
 * @returns {Buffer}
 */
export function buildEpub(chapters, images = []) {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile('META-INF/container.xml', Buffer.from(
        `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`
        + `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
    const items = chapters.map((c, i) =>
        `<item id="c${i}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('');
    const imageItems = images.map((img, i) =>
        `<item id="img${i}" href="${img.href}" media-type="${img.mediaType ?? 'image/png'}"`
        + `${img.cover ? ' properties="cover-image"' : ''}/>`).join('');
    const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('');
    zip.addFile('OEBPS/content.opf', Buffer.from(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">`
        + `<manifest>${items}${imageItems}</manifest><spine>${spine}</spine></package>`));
    for (const c of chapters) {
        zip.addFile(`OEBPS/${c.href}`, Buffer.from(
            `<html><head><title>${c.title}</title></head><body>${c.body}</body></html>`));
    }
    for (const [i, img] of images.entries()) {
        zip.addFile(`OEBPS/${img.href}`, img.data ?? buildPng(i + 1));
    }
    return zip.toBuffer();
}
