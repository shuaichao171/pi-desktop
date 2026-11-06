import { findPathMatches } from './changesFind';
import { parsePiEditDiff, parseUnifiedDiff } from './unifiedDiff';
import { literalMatchRanges } from './workbenchReading';
import type { DiffRequest, DiffResponse } from './diffWorkerTypes';

// Pure string work: parse failures cannot happen, so every request answers once.
self.onmessage = (event: MessageEvent<DiffRequest>) => {
  const request = event.data;
  let response: DiffResponse;
  if (request.type === 'unified') response = { type: 'unified', lines: parseUnifiedDiff(request.text) };
  else if (request.type === 'pi-edit') response = { type: 'pi-edit', lines: parsePiEditDiff(request.text) };
  else if (request.type === 'reading-find') response = { type: 'reading-find', ranges: literalMatchRanges(request.text, request.query) };
  else response = { type: 'changes-find', result: findPathMatches(request.paths, request.query, new Map(request.diffTexts)) };
  self.postMessage(response);
};
