/* Render an HTML file to PDF with the browser that is already here.

   LibreOffice cannot open these .docx files, so a marking-guidelines
   document that only exists as .docx is converted to HTML first and laid
   out by Chromium. The result is a page the cropper can slice like any
   other, with the tables and diagrams intact. */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const [, , htmlPath, pdfPath] = process.argv;
const b = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
await p.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
await p.pdf({ path: pdfPath, format: 'A4', printBackground: true,
              margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' } });
await b.close();
