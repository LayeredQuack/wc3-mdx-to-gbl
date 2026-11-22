/**
 * Recursive filesystem discovery for input model files.
 */

import * as fs from 'fs';
import * as path from 'path';

export function getFilesRecursive(dir: string, ext: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getFilesRecursive(fullPath, ext, fileList);
    } else if (fullPath.toLowerCase().endsWith(ext)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}
