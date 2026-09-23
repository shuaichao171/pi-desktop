import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { UiProviderAuthStatus, UiThinkingLevel } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { Icon } from './Icons';

type SettingsPage = 'model' | 'credentials' | 'about';

const THINKING_LABELS: Record<string, string> = {
	off: '关闭',
	minimal: '极简',
	low: '低',
	medium: '中',
	high: '高',
	xhigh: '极高',
	max: '最高',
};

function readableModelSize(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '';
	return value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : `${Math.round(value / 1000)}K`;
}

function authSourceLabel({ configured, source }: UiProviderAuthStatus): string {
	if (!configured) return '无可用凭据';
	switch (source) {
		case 'stored': return 'Pi 已保存凭据';
		case 'runtime': return '运行时凭据可用';
		case 'environment': return '环境变量已配置';
		case 'models_json_key': return '模型配置文件已配置';
		case 'models_json_command': return '模型配置命令可用';
		case 'fallback': return '其他凭据可用';
		default: return '凭据可用';
	}
}

function ProviderCredentialRow({ provider, configured, source, supportsApiKey }: UiProviderAuthStatus) {
	const [secret, setSecret] = useState('');
	const [pending, setPending] = useState(false);
	const [feedback, setFeedback] = useState<string | null>(null);
	const status = useChatStore((s) => s.status);
	const settingsLoading = useChatStore((s) => s.settingsLoading);
	const setProviderApiKey = useChatStore((s) => s.setProviderApiKey);
	const removeProviderCredential = useChatStore((s) => s.removeProviderCredential);
	const canChange = status === 'idle' && !settingsLoading && !pending;

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = secret.trim();
		if (!value || !canChange) return;
		setSecret('');
		setPending(true);
		setFeedback(null);
		try {
			await setProviderApiKey(provider, value);
			setFeedback('Pi 本地凭据已保存');
		} catch (error) {
			setFeedback(`保存失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setPending(false);
		}
	}

	async function remove() {
		if (!canChange) return;
		setPending(true);
		setFeedback(null);
		try {
			await removeProviderCredential(provider);
			setFeedback('Pi 本地保存的凭据已移除。');
		} catch (error) {
			setFeedback(`移除失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="pd-provider-card">
			<div className="pd-provider-card-heading"><strong>{provider}</strong><span className={`pd-provider-auth-state${configured ? ' is-configured' : ''}`}>{authSourceLabel({ provider, configured, source, supportsApiKey })}</span></div>
			{supportsApiKey ? <form onSubmit={(event) => void save(event)} className="pd-provider-form">
				<label htmlFor={`pd-api-key-${provider}`}>API Key</label>
				<div className="pd-provider-form-row">
					<input id={`pd-api-key-${provider}`} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" spellCheck={false} placeholder={configured ? '输入新密钥以替换' : '输入密钥'} disabled={!canChange} />
					<button type="submit" className="pd-settings-primary" disabled={!secret.trim() || !canChange}>{pending ? '处理中…' : '保存'}</button>
				</div>
			</form> : <p className="pd-provider-method-note">此提供商不支持在这里输入 API Key。</p>}
			{source === 'stored' && <button type="button" className="pd-settings-remove" onClick={() => void remove()} disabled={!canChange}>移除 Pi 本地保存的凭据</button>}
			{feedback && <p className="pd-settings-feedback" role="status">{feedback}</p>}
		</div>
	);
}

export function SettingsPanel({ onClose }: { onClose(): void }) {
	const [page, setPage] = useState<SettingsPage>('model');
	const [modelSearch, setModelSearch] = useState('');
	const [actionError, setActionError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const models = useChatStore((s) => s.models);
	const model = useChatStore((s) => s.model);
	const modelProvider = useChatStore((s) => s.modelProvider);
	const thinkingLevel = useChatStore((s) => s.thinkingLevel);
	const availableThinkingLevels = useChatStore((s) => s.availableThinkingLevels);
	const providerAuth = useChatStore((s) => s.providerAuth);
	const settingsLoading = useChatStore((s) => s.settingsLoading);
	const settingsError = useChatStore((s) => s.settingsError);
	const status = useChatStore((s) => s.status);
	const cwd = useChatStore((s) => s.cwd);
	const appInfo = useChatStore((s) => s.appInfo);
	const refreshModels = useChatStore((s) => s.refreshModels);
	const refreshProviderAuth = useChatStore((s) => s.refreshProviderAuth);
	const setModel = useChatStore((s) => s.setModel);
	const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
	const canChangeAgent = status === 'idle' && !settingsLoading;
	const waitingForAgent = status === 'starting' || status === 'uninitialized';
	const filteredModels = useMemo(() => {
		const query = modelSearch.trim().toLocaleLowerCase();
		return models.filter((item) => `${item.provider} ${item.id} ${item.name}`.toLocaleLowerCase().includes(query)).slice(0, 80);
	}, [models, modelSearch]);
	const sortedProviderAuth = useMemo(() => [...providerAuth].sort((a, b) => Number(b.configured) - Number(a.configured) || a.provider.localeCompare(b.provider)), [providerAuth]);

	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		return () => {
			if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
			else document.querySelector<HTMLButtonElement>('.pd-header-settings')?.focus();
		};
	}, []);

	useEffect(() => {
		if (waitingForAgent) return;
		void refreshModels().catch(() => {});
		void refreshProviderAuth().catch(() => {});
	}, [waitingForAgent, refreshModels, refreshProviderAuth]);

	function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
		if (event.key !== 'Tab') return;
		const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])');
		if (!elements?.length) return;
		const first = elements[0];
		const last = elements[elements.length - 1];
		if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
	}

	async function updateModel(provider: string, id: string) {
		setPending(true);
		setActionError(null);
		try { await setModel(provider, id); }
		catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
		finally { setPending(false); }
	}

	async function updateThinking(level: UiThinkingLevel) {
		setPending(true);
		setActionError(null);
		try { await setThinkingLevel(level); }
		catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
		finally { setPending(false); }
	}

	return (
		<div className="pd-settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div ref={dialogRef} className="pd-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="pd-settings-title" onKeyDown={onDialogKeyDown}>
				<header className="pd-settings-header"><div><span className="pd-settings-eyebrow">PI DESKTOP</span><h1 id="pd-settings-title">设置</h1></div><button ref={closeRef} type="button" className="pd-icon-button" onClick={onClose} aria-label="关闭设置"><Icon name="close" /></button></header>
				<div className="pd-settings-layout">
					<nav className="pd-settings-nav" aria-label="设置分类">
						<button type="button" className={page === 'model' ? 'is-active' : ''} aria-current={page === 'model' ? 'page' : undefined} onClick={() => setPage('model')}>模型与思考</button>
						<button type="button" className={page === 'credentials' ? 'is-active' : ''} aria-current={page === 'credentials' ? 'page' : undefined} onClick={() => setPage('credentials')}>提供商凭据</button>
						<button type="button" className={page === 'about' ? 'is-active' : ''} aria-current={page === 'about' ? 'page' : undefined} onClick={() => setPage('about')}>关于</button>
					</nav>
					<div className="pd-settings-content">
						{(actionError || settingsError) && <div className="pd-settings-error" role="alert">{actionError || settingsError}</div>}
						{page === 'model' && <>
							<div className="pd-settings-section-head"><h2>模型</h2><p>当前会话使用 <strong>{modelProvider ? `${modelProvider}/` : ''}{model || '未选择'}</strong>。切换模型会用于后续回复。</p></div>
							<input className="pd-settings-model-search" type="search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} aria-label="搜索模型" placeholder="搜索模型或提供商" />
							<div className="pd-settings-model-list" aria-label="可用模型">
								{filteredModels.map((item) => {
									const selected = item.provider === modelProvider && item.id === model;
									return <button key={`${item.provider}/${item.id}`} type="button" className={`pd-settings-model-row${selected ? ' is-selected' : ''}`} aria-pressed={selected} disabled={!canChangeAgent || pending} onClick={() => void updateModel(item.provider, item.id)}>
										<span className="pd-settings-model-copy"><strong>{item.name || item.id}</strong><small>{item.provider}/{item.id}</small></span>
										<span className="pd-settings-model-meta">{item.reasoning ? '推理' : '非推理'}{item.input.includes('image') ? ' · 图片' : ''}{item.contextWindow ? ` · ${readableModelSize(item.contextWindow)} 上下文` : ''}</span>
										{selected && <span className="pd-settings-model-selected">使用中</span>}
									</button>;
								})}
								{filteredModels.length === 0 && <div className="pd-settings-empty">{settingsLoading || waitingForAgent ? '正在加载模型…' : status === 'error' ? 'Pi 连接失败，请查看聊天页的错误信息。' : modelSearch ? '没有匹配的模型。' : '尚无可用模型。请检查提供商凭据。'}</div>}
							</div>
							{models.length > 80 && <p className="pd-settings-hint">仅显示前 80 个结果，可输入名称进一步筛选。</p>}
							<div className="pd-settings-divider" />
							<div className="pd-settings-section-head"><h2>思考级别</h2><p>选择 Pi 在回答前使用的推理强度。</p></div>
							<div className="pd-thinking-options" role="group" aria-label="思考级别">
								{availableThinkingLevels.map((level) => <button key={level} type="button" className={thinkingLevel === level ? 'is-selected' : ''} aria-pressed={thinkingLevel === level} disabled={!canChangeAgent || pending} onClick={() => void updateThinking(level)}>{THINKING_LABELS[level] ?? level}</button>)}
								{availableThinkingLevels.length === 0 && <span className="pd-settings-hint">当前模型没有可选的思考级别。</span>}
							</div>
							{status !== 'idle' && <p className="pd-settings-hint">Pi 完成当前任务后即可更改模型和思考级别。</p>}
						</>}
						{page === 'credentials' && <>
							<div className="pd-settings-section-head"><h2>提供商凭据</h2><p>状态可能来自 Pi 本地凭据、环境变量或模型配置文件。这里只能移除 Pi 本地保存的凭据；输入框不会保存或回显密钥。</p></div>
							<div className="pd-provider-list">{sortedProviderAuth.map((item) => <ProviderCredentialRow key={item.provider} {...item} />)}</div>
							{providerAuth.length === 0 && <div className="pd-settings-empty">{settingsLoading || waitingForAgent ? '正在检查提供商…' : status === 'error' ? 'Pi 连接失败，请查看聊天页的错误信息。' : '暂未发现可配置的提供商。'}</div>}
							{status !== 'idle' && <p className="pd-settings-hint">Pi 完成当前任务后即可修改凭据。</p>}
						</>}
						{page === 'about' && <>
							<div className="pd-settings-section-head"><h2>关于 Pi Desktop</h2><p>基于 Pi SDK 的本地桌面工作台。</p></div>
							<dl className="pd-about-list"><div><dt>应用版本</dt><dd>{appInfo?.appVersion ?? '未知'}</dd></div><div><dt>Electron</dt><dd>{appInfo?.electronVersion ?? '—'}</dd></div><div><dt>Node.js</dt><dd>{appInfo?.nodeVersion ?? '—'}</dd></div><div><dt>平台</dt><dd>{appInfo?.platform ?? '—'}</dd></div><div><dt>当前工作区</dt><dd title={cwd}>{cwd || '尚未选择'}</dd></div></dl>
						</>}
					</div>
				</div>
			</div>
		</div>
	);
}
