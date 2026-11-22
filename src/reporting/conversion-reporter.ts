/**
 * Collects and reports conversion diagnostics for batch MDX → glTF runs.
 */

import type { ConversionRecord } from '../types/conversion';

export class ModelConversionReporter {
  private successCount = 0;
  private skippedCount = 0;
  private errorCount = 0;
  private records: ConversionRecord[] = [];

  public logSuccess(filePath: string, bytes: number): void {
    this.successCount++;
    this.records.push({ filePath, bytes, status: 'success' });
  }

  public logSkipped(filePath: string, reason: string): void {
    this.skippedCount++;
    console.warn(`[Skipped] ${reason}: ${filePath}`);
    this.records.push({ filePath, bytes: 0, status: 'skipped' });
  }

  public logError(filePath: string, errorMsg: string): void {
    this.errorCount++;
    console.error(`[Error] Failed to convert ${filePath}: ${errorMsg}`);
    this.records.push({ filePath, bytes: 0, status: 'error', errorMsg });
  }

  public generateReport(inputDir: string, outputDir: string): string {
    let report = '\n========================================\n';
    report += '         MODEL CONVERSION REPORT        \n';
    report += '========================================\n';
    report += `Timestamp           : ${new Date().toISOString()}\n`;
    report += `Input Directory     : ${inputDir}\n`;
    report += `Output Directory    : ${outputDir}\n`;
    report += `Total Successful    : ${this.successCount}\n`;
    report += `Total Skipped       : ${this.skippedCount}\n`;
    report += `Total Errors        : ${this.errorCount}\n`;
    report += '----------------------------------------\n';

    if (this.records.length > 0) {
      report += '\nProcessed Files Sample:\n';
      this.records.slice(0, 10).forEach((rec) => {
        report += `  [${rec.status.toUpperCase()}] ${rec.filePath} (${rec.bytes} bytes)\n`;
      });
      if (this.records.length > 10) {
        report += `  ... and ${this.records.length - 10} more files.\n`;
      }
    }
    report += '\n========================================\n';
    return report;
  }
}
