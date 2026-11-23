import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-data');
fs.mkdirSync(ROOT, { recursive: true });

export function testDataDir(name = '') {
    return path.join(ROOT, name);
}
