import type { ChangeFindResult } from './changesFind';
import type { DiffLine, EditDiffLine } from './unifiedDiff';

/** Requests crossing the diff worker boundary; only strings travel. */
export type DiffRequest =
  | { type: 'unified'; text: string }
  | { type: 'pi-edit'; text: string }
  | { type: 'changes-find'; paths: string[]; query: string; diffTexts: Array<[path: string, diff: string]> };

export type DiffResponse =
  | { type: 'unified'; lines: DiffLine[] }
  | { type: 'pi-edit'; lines: EditDiffLine[] }
  | { type: 'changes-find'; result: ChangeFindResult };
