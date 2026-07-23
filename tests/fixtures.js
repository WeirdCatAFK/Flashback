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
 * An EPUB with the full container.xml → OPF → spine chain mcpReader walks.
 * @param {{href: string, title: string, body: string}[]} chapters - body is XHTML.
 * @returns {Buffer}
 */
export function buildEpub(chapters) {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile('META-INF/container.xml', Buffer.from(
        `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`
        + `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
    const items = chapters.map((c, i) =>
        `<item id="c${i}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('');
    const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('');
    zip.addFile('OEBPS/content.opf', Buffer.from(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">`
        + `<manifest>${items}</manifest><spine>${spine}</spine></package>`));
    for (const c of chapters) {
        zip.addFile(`OEBPS/${c.href}`, Buffer.from(
            `<html><head><title>${c.title}</title></head><body>${c.body}</body></html>`));
    }
    return zip.toBuffer();
}
