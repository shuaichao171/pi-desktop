/** A file mentioned in a result, resolved relative to the conversation's directory. */
export interface ResultFileTarget {
  cwd: string;
  path: string;
  line?: number;
  column?: number;
  /** Absolute paths the conversation text mentioned for this file (newest first),
   * tried when the path does not resolve under cwd — a model often names just the
   * file after searching another directory. */
  candidates?: string[];
}

export interface ResultFilePreview {
  path: string;
  name: string;
  size: number;
  kind: 'text' | 'html' | 'image' | 'pdf' | 'office' | 'unsupported' | 'directory';
  text?: string;
  dataUrl?: string;
  officeFormat?: 'docx' | 'xlsx' | 'pptx';
  bytesBase64?: string;
  truncated?: boolean;
  reason?: 'too-large' | 'unsupported';
}

export interface ResultFilesBridge {
  openResultFile(target: ResultFileTarget): Promise<void>;
  revealResultFile(target: ResultFileTarget): Promise<void>;
  previewResultFile(target: ResultFileTarget): Promise<ResultFilePreview>;
}
