import { cpSync } from 'node:fs';
for (const dir of ['cmaps','standard_fonts','wasm']) {
  cpSync('node_modules/pdfjs-dist/' + dir, 'public/pdf-assets/' + dir, {recursive:true});
}
