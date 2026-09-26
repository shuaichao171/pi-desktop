import type { UiFileChange } from '@pidesktop/shared';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icons';

export function ChangeStats({ items }: { items: UiFileChange[] }) {
  const { t } = useT();
  const total = (side: 'additions' | 'deletions') => items.some(item => typeof item[side] === 'number')
    ? items.reduce((sum, item) => sum + (item[side] ?? 0), 0) : null;
  const additions = total('additions'), deletions = total('deletions');
  if (additions === null && deletions === null) return null;
  const partial = items.some(item => item.additions == null || item.deletions == null);
  const description = t(partial ? 'changes.partialStats' : 'changes.stats', { additions: additions ?? '—', deletions: deletions ?? '—' });
  return <span className="pd-change-stats" aria-label={description} title={partial ? description : undefined}>
    <span className="pd-change-added" aria-hidden="true">+{additions ?? '—'}</span>
    <span className="pd-change-deleted" aria-hidden="true">−{deletions ?? '—'}</span>
    {partial && <span aria-hidden="true">*</span>}
  </span>;
}

function fileIcon(path: string): IconName {
  const extension = path.split(/[\\/]/).at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
  if (/^(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/.test(extension)) return 'image';
  if (/^(?:[cm]?jsx?|tsx?|css|scss|less|html?|json|ya?ml|toml|xml|py|rs|go|java|c|cpp|cc|h|cs|sh|ps1|rb|php|swift|sql|vue|svelte)$/.test(extension)) return 'code';
  return 'file';
}

export function FileLabel({ item, compact = false }: { item: UiFileChange; compact?: boolean }) {
  const { t, locale } = useT();
  const parts = item.path.split(/[\\/]/), name = parts.pop() || item.path;
  const status = locale === 'zh-CN'
    ? { added: '新增', modified: '修改', deleted: '删除' }[item.kind]
    : { added: 'Added', modified: 'Modified', deleted: 'Deleted' }[item.kind];
  return <>
    <span className="pd-change-file-icon" aria-hidden="true"><Icon name={fileIcon(item.path)} width="15" height="15" /></span>
    <span className="pd-change-filename">{parts.length > 0 && <small>{parts.join('/')}/</small>}<span>{name}</span></span>
    <span className={`pd-change-file-state is-${item.kind}${compact ? ' is-compact' : ''}`} aria-label={t(`changes.${item.kind}`)}>{status}</span>
  </>;
}
