import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { OfficeParagraph, OfficePreview } from '../officePreviewTypes';
import './officeFilePreview.css';

function Paragraph({ value }: { value: OfficeParagraph }) {
  return <p className={value.heading ? `is-heading level-${value.heading}` : undefined} role={value.heading ? 'heading' : undefined} aria-level={value.heading}>{value.runs.map((run, index) => <span key={index} style={{ fontWeight: run.bold ? 700 : undefined, fontStyle: run.italic ? 'italic' : undefined, textDecoration: run.underline ? 'underline' : undefined }}>{run.text}</span>)}</p>;
}
function columnName(index: number): string { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; }

export default function OfficeFilePreview({ bytesBase64, format }: { bytesBase64: string; format: 'docx' | 'xlsx' | 'pptx' }) {
  const { t, locale } = useT();
  const [preview, setPreview] = useState<OfficePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [rowLimit, setRowLimit] = useState(100);
  useEffect(() => {
    let active = true, worker: Worker | undefined;
    setPreview(null); setError(null); setSheetIndex(0); setRowLimit(100);
    const timeout = setTimeout(() => { if (active) setError(t('officePreview.timeout')); worker?.terminate(); }, 15_000);
    try {
      if (bytesBase64.length > 14 * 1024 * 1024) throw new Error('File is too large');
      const bytes = Uint8Array.from(atob(bytesBase64), char => char.charCodeAt(0));
      worker = new Worker(new URL('../officePreview.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ preview?: OfficePreview; error?: string }>) => { if (!active) return; clearTimeout(timeout); setPreview(event.data.preview ?? null); setError(event.data.error ?? null); worker?.terminate(); };
      worker.onerror = () => { if (active) setError(t('officePreview.processFailed')); clearTimeout(timeout); worker?.terminate(); };
      worker.postMessage({ bytes, format }, [bytes.buffer]);
    } catch (cause) { clearTimeout(timeout); setError(cause instanceof Error ? cause.message : String(cause)); worker?.terminate(); }
    return () => { active = false; clearTimeout(timeout); worker?.terminate(); };
  }, [bytesBase64, format, locale]);
  if (error) return <div className="pd-result-file-preview-state" role="alert"><strong>{t('officePreview.unavailable')}</strong><p>{error}</p></div>;
  if (!preview) return <div className="pd-result-file-preview-state" role="status"><p>{t('officePreview.reading')}</p></div>;
  const sheet = preview.format === 'xlsx' ? preview.sheets[sheetIndex] : undefined;
  return <div className="pd-office-preview">
    <div className="pd-office-preview-toolbar"><span>{t('officePreview.readOnly')}</span>{preview.format === 'xlsx' && <label>{t('officePreview.sheet')} <select aria-label={t('officePreview.sheet')} value={sheetIndex} onChange={event => { setSheetIndex(Number(event.target.value)); setRowLimit(100); }}>{preview.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></label>}</div>
    <p className="pd-office-preview-note">{preview.format === 'docx' ? t('officePreview.noteDocument') : preview.format === 'pptx' ? t('officePreview.notePresentation') : t('officePreview.noteSpreadsheet')}{preview.truncated && <strong> {t('officePreview.truncated')}</strong>}</p>
    <div className="pd-office-preview-content" tabIndex={0} aria-label={t('officePreview.content')}>
      {preview.format === 'docx' ? <article className="pd-office-document">{preview.blocks.map((block, index) => block.type === 'paragraph' ? <Paragraph key={index} value={block} /> : <table key={index}><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell.map((paragraph, paragraphIndex) => <Paragraph key={paragraphIndex} value={paragraph} />)}</td>)}</tr>)}</tbody></table>)}</article> : preview.format === 'pptx' ? <div className="pd-office-slides">
        {preview.slides.map(slide => <section key={slide.index} className="pd-office-slide" aria-label={t('officePreview.slideNumber', { index: slide.index })}><h3>{t('officePreview.slide')} {slide.index}</h3>{slide.texts.length ? slide.texts.map((text, index) => <p key={index}>{text}</p>) : <p className="pd-office-slide-empty">{t('officePreview.slideEmpty')}</p>}</section>)}
        {preview.slides.length === 0 && <p>{t('officePreview.noSlides')}</p>}
      </div> : sheet && <>
        <table className="pd-office-sheet" aria-label={sheet.name}><thead><tr><th scope="col">#</th>{Array.from({ length: sheet.columns }, (_, index) => <th key={index} scope="col">{columnName(index)}</th>)}</tr></thead><tbody>{sheet.rows.slice(0, rowLimit).map(row => <tr key={row.number}><th scope="row">{row.number}</th>{Array.from({ length: sheet.columns }, (_, column) => <td key={column} title={row.cells[column] ?? ''}>{row.cells[column] ?? ''}</td>)}</tr>)}</tbody></table>
        {rowLimit < sheet.rows.length && <button type="button" className="pd-workbench-show-lines" onClick={() => setRowLimit(value => value + 100)}>{t('officePreview.moreRows')} ({Math.min(rowLimit, sheet.rows.length)}/{sheet.rows.length})</button>}
        {sheet.rows.length === 0 && <p>{t('officePreview.sheetEmpty')}</p>}
      </>}
    </div>
  </div>;
}
