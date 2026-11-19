/**
 * Shared conversion-related types used across the MDX → glTF pipeline.
 */

export interface ConversionRecord {
  filePath: string;
  bytes: number;
  status: 'success' | 'skipped' | 'error';
  errorMsg?: string;
}

export interface TextureIndex {
  root: string;
  fullRel: Map<string, string>;
  byBase: Map<string, string[]>;
  bySuffix: Map<string, string[]>;
  byNameToken: Map<string, string[]>;
  allBlps: string[];
}

export interface FuzzyTextureCandidate {
  abs: string;
  rel: string;
  nameScore: number;
  contextScore: number;
  totalScore: number;
  reason: string;
}
