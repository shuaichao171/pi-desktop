import type { UiFileChange } from '@pidesktop/shared';
import { useT } from '../i18n';
import { FileDisplayIcon } from './FileDisplayIcon';

export function FileLabel({ item, compact = false }: { item: UiFileChange; compact?: boolean }) {
  const { t, locale } = useT();
  const parts = item.path.split(/[\\/]/), name = parts.pop() || item.path;
  const status = locale === 'zh-CN'
    ? { added: '新增', modified: '修改', deleted: '删除' }[item.kind]
    : { added: 'Added', modified: 'Modified', deleted: 'Deleted' }[item.kind];
  return <>
    <span className="pd-change-file-icon" aria-hidden="true"><FileDisplayIcon name={name} /></span>
    <span className="pd-change-filename">{parts.length > 0 && <small><bdi>{parts.join('/')}/</bdi></small>}<span>{name}</span></span>
    <span className={`pd-change-file-state is-${item.kind}${compact ? ' is-compact' : ''}`} aria-label={t(`changes.${item.kind}`)}>{status}</span>
  </>;
}
