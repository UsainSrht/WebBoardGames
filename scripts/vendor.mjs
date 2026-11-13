// Copies browser libraries out of node_modules into public_html/vendor (checked in, refreshed by `npm run build`).
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public_html/vendor', { recursive: true });
copyFileSync('node_modules/qrcode-generator/dist/qrcode.js', 'public_html/vendor/qrcode.js');
console.log('vendor: qrcode.js copied');
