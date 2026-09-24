import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiAutomation, UiAutomationInput, UiAutomationRun, UiAutomationSchedule, UiAutomationSnapshot, UiModelSummary, UiThinkingLevel } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { useT, type Locale, type Translate } from '../i18n';
import { Icon } from './Icons';
import { SegmentedIndicator } from './SegmentedIndicator';
import './automationPage.css';

const EMPTY: UiAutomationSnapshot = { revision: -1, automations: [], runs: [] };
const WEEKDAYS = [1, 2, 3, 4, 5];
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const LEVELS: UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
type Frequency = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'once';
type Filter = 'all' | 'active' | 'paused';
const pathLeaf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function dateLabel(value: string | null, locale: Locale, zone?: string): string {
	if (!value) return '—';
	try { return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(value)); }
	catch { return value; }
}
function dayLabel(day: number, locale: Locale): string {
	return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + day)));
}
function scheduleLabel(schedule: UiAutomationSchedule, locale: Locale, t: Translate, zone: string): string {
	if (schedule.kind === 'interval') return schedule.minutes % 60 === 0 ? t('automation.everyHours', { count: schedule.minutes / 60 }) : t('automation.everyMinutes', { count: schedule.minutes });
	if (schedule.kind === 'once') return t('automation.onceAt', { time: dateLabel(schedule.at, locale, zone) });
	const days = schedule.days.length === 7 ? t('automation.daily') : schedule.days.length === 5 && WEEKDAYS.every((day) => schedule.days.includes(day)) ? t('automation.weekdays') : DAYS.filter((day) => schedule.days.includes(day)).map((day) => dayLabel(day, locale)).join(' · ');
	return `${days} ${schedule.time}`;
}
function localInputDate(value: string): string {
	const date = new Date(value);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Native modal dialogs provide focus containment and restore focus to their trigger. */
function Modal({ title, children, onClose, busy = false, className = '' }: { title: string; children: ReactNode; onClose(): void; busy?: boolean; className?: string }) {
	const { t } = useT();
	const ref = useRef<HTMLDialogElement>(null);
	const id = useId();
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => { dialog?.close(); };
	}, []);
	return createPortal(<dialog ref={ref} className={`pd-automation-dialog ${className}`} role="dialog" aria-labelledby={id} aria-modal="true" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
		<header><h2 id={id}>{title}</h2><button type="button" className="pd-icon-button" aria-label={t('automation.close')} onClick={onClose} disabled={busy}><Icon name="close" /></button></header>
		{children}
	</dialog>, document.body);
}

function AutomationEditor({ initial, workspaces, models, busy, error, onSave, onClose }: { initial: UiAutomationInput; workspaces: string[]; models: UiModelSummary[]; busy: boolean; error: string | null; onSave(input: UiAutomationInput): void; onClose(): void }) {
	const { t, locale } = useT();
	const [name, setName] = useState(initial.name);
	const [prompt, setPrompt] = useState(initial.prompt);
	const [cwd, setCwd] = useState(initial.cwd);
	const [modelKey, setModelKey] = useState(initial.model ? JSON.stringify([initial.model.provider, initial.model.id]) : '');
	const [thinking, setThinking] = useState<UiThinkingLevel | ''>(initial.thinkingLevel ?? '');
	const [enabled, setEnabled] = useState(initial.enabled);
	const [frequency, setFrequency] = useState<Frequency>(() => initial.schedule.kind !== 'weekly' ? initial.schedule.kind : initial.schedule.days.length === 7 ? 'daily' : initial.schedule.days.length === 5 && WEEKDAYS.every((day) => initial.schedule.kind === 'weekly' && initial.schedule.days.includes(day)) ? 'weekdays' : 'weekly');
	const [minutes, setMinutes] = useState(initial.schedule.kind === 'interval' ? String(initial.schedule.minutes) : '60');
	const [days, setDays] = useState(initial.schedule.kind === 'weekly' ? initial.schedule.days : WEEKDAYS);
	const [time, setTime] = useState(initial.schedule.kind === 'weekly' ? initial.schedule.time : '09:00');
	const [onceAt, setOnceAt] = useState(localInputDate(initial.schedule.kind === 'once' ? initial.schedule.at : new Date(Date.now() + 60 * 60_000).toISOString()));
	const [zone, setZone] = useState(initial.timeZone);
	const [validation, setValidation] = useState<string | null>(null);
	const errorRef = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (validation || error) errorRef.current?.scrollIntoView({ block: 'nearest' });
	}, [validation, error]);
	const selectedModel = models.find((model) => JSON.stringify([model.provider, model.id]) === modelKey);
	const missingModel = modelKey && !selectedModel;
	function submit(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setValidation(null);
		if (!name.trim() || !prompt.trim() || !cwd) { setValidation(t('automation.required')); return; }
		if (frequency === 'weekly' && !days.length) { setValidation(t('automation.chooseDay')); return; }
		if (frequency === 'interval' && (!Number.isInteger(Number(minutes)) || Number(minutes) < 5 || Number(minutes) > 43200)) { setValidation(t('automation.invalidInterval')); return; }
		const timeZone = frequency === 'once' ? localZone() : zone.trim();
		try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { setValidation(t('automation.invalidZone')); return; }
		const at = new Date(onceAt);
		if (frequency === 'once' && (!Number.isFinite(at.getTime()) || (enabled && at.getTime() <= Date.now()))) { setValidation(t('automation.futureTime')); return; }
		const schedule: UiAutomationSchedule = frequency === 'interval' ? { kind: 'interval', minutes: Number(minutes) } : frequency === 'once' ? { kind: 'once', at: at.toISOString() } : { kind: 'weekly', days: frequency === 'daily' ? DAYS : frequency === 'weekdays' ? WEEKDAYS : days, time };
		const [provider, modelId] = modelKey ? JSON.parse(modelKey) as [string, string] : ['', ''];
		onSave({ ...initial, name: name.trim(), prompt: prompt.trim(), cwd, model: modelKey ? { provider, id: modelId } : null, thinkingLevel: selectedModel && !selectedModel.reasoning ? null : thinking || null, schedule, timeZone, enabled });
	}
	return <Modal title={t(initial.id ? 'automation.edit' : 'automation.create')} onClose={onClose} busy={busy}>
		<form onSubmit={submit} className="pd-automation-form">
			<div className="pd-automation-form-body">
				<label className="pd-automation-field"><span>{t('automation.name')}</span><input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('automation.namePlaceholder')} disabled={busy} /></label>
				<label className="pd-automation-field"><span>{t('automation.prompt')}</span><textarea required rows={5} maxLength={32000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('automation.promptPlaceholder')} disabled={busy} /><small>{t('automation.promptHint')}</small></label>
				<label className="pd-automation-field"><span>{t('automation.project')}</span><select required value={cwd} onChange={(event) => setCwd(event.target.value)} disabled={busy}><option value="">{t('automation.chooseProject')}</option>{[...new Set([...workspaces, ...(cwd ? [cwd] : [])])].map((path) => <option key={path} value={path}>{pathLeaf(path)} — {path}</option>)}</select>{!workspaces.length && <small>{t('automation.noProjects')}</small>}</label>
				<div className="pd-automation-field-pair">
					<label className="pd-automation-field"><span>{t('automation.model')}</span><select value={modelKey} onChange={(event) => setModelKey(event.target.value)} disabled={busy}><option value="">{t('automation.defaultModel')}</option>{missingModel && <option value={modelKey}>{initial.model?.id} ({t('automation.unavailable')})</option>}{models.map((model) => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.name} · {model.provider}</option>)}</select></label>
					<label className="pd-automation-field"><span>{t('automation.thinking')}</span><select value={thinking} onChange={(event) => setThinking(event.target.value as UiThinkingLevel | '')} disabled={busy || Boolean(selectedModel && !selectedModel.reasoning)}><option value="">{t('automation.defaultThinking')}</option>{LEVELS.map((level) => <option key={level} value={level}>{t(`composer.thinking.${level}`)}</option>)}</select></label>
				</div>
				<div className="pd-automation-schedule-fields">
					<div className="pd-automation-field-pair"><label className="pd-automation-field"><span>{t('automation.frequency')}</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as Frequency)} disabled={busy}>{(['daily', 'weekdays', 'weekly', 'interval', 'once'] as Frequency[]).map((value) => <option key={value} value={value}>{t(`automation.${value}`)}</option>)}</select></label>
					{frequency === 'interval' ? <label className="pd-automation-field"><span>{t('automation.intervalMinutes')}</span><input type="number" required min={5} max={43200} step={1} value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={busy} /></label> : frequency === 'once' ? <label className="pd-automation-field"><span>{t('automation.localDate')}</span><input type="datetime-local" required value={onceAt} onChange={(event) => setOnceAt(event.target.value)} disabled={busy} /></label> : <label className="pd-automation-field"><span>{t('automation.time')}</span><input type="time" required value={time} onChange={(event) => setTime(event.target.value)} disabled={busy} /></label>}</div>
					{frequency === 'weekly' && <fieldset className="pd-automation-days"><legend>{t('automation.days')}</legend>{DAYS.map((day) => <button key={day} type="button" aria-pressed={days.includes(day)} onClick={() => setDays((old) => old.includes(day) ? old.filter((value) => value !== day) : [...old, day])} disabled={busy}>{dayLabel(day, locale)}</button>)}</fieldset>}
					<label className="pd-automation-field"><span>{t('automation.timeZone')}</span><input required value={frequency === 'once' ? localZone() : zone} onChange={(event) => setZone(event.target.value)} disabled={busy || frequency === 'once'} placeholder="Asia/Shanghai" /></label>
				</div>
				<label className="pd-automation-enable"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} /><span>{t('automation.enableAfterSave')}</span></label>
				<p className="pd-automation-local-note"><Icon name="clock" width="14" height="14" />{t('automation.localHint')}</p>
				{(validation || error) && <p ref={errorRef} role="alert" className="pd-automation-error">{validation || error}</p>}
			</div>
			<footer><button className="pd-automation-button" type="button" onClick={onClose} disabled={busy}>{t('automation.cancel')}</button><button className="pd-automation-button is-primary" type="submit" disabled={busy || !cwd}>{t(busy ? 'automation.saving' : 'automation.save')}</button></footer>
		</form>
	</Modal>;
}

export function AutomationPage({ onToggleSidebar, onOpenSession }: { onToggleSidebar(): void; onOpenSession(cwd: string, path: string): Promise<boolean> }) {
	const { t, locale } = useT();
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const storedWorkspaces = useChatStore((state) => state.workspaces);
	const storedModels = useChatStore((state) => state.models);
	const [snapshot, setSnapshot] = useState(EMPTY);
	const [models, setModels] = useState(storedModels);
	const [workspaces, setWorkspaces] = useState(storedWorkspaces);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<Filter>('all');
	const [busy, setBusy] = useState(false);
	const [editor, setEditor] = useState<UiAutomationInput | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<UiAutomation | null>(null);
	const [historyId, setHistoryId] = useState<string | 'all' | null>(null);
	const [retry, setRetry] = useState(0);
	const active = useRef(false);
	const busyRef = useRef(false);

	useEffect(() => {
		active.current = true;
		return () => { active.current = false; };
	}, []);
	useEffect(() => { setModels(storedModels); }, [storedModels]);
	useEffect(() => { setWorkspaces(storedWorkspaces); }, [storedWorkspaces]);
	useEffect(() => {
		if (!bridge) return;
		let alive = true;
		const apply = (value: UiAutomationSnapshot) => { if (alive) setSnapshot((old) => value.revision >= old.revision ? value : old); };
		setLoading(true);
		setError(null);
		const unsubscribe = bridge.onAutomationChanged(apply);
		void bridge.getAutomationSnapshot().then(apply).catch((cause) => { if (alive) setError(errorText(cause)); }).finally(() => { if (alive) setLoading(false); });
		void Promise.allSettled([bridge.listWorkspaces(), bridge.listModels()]).then(([projects, availableModels]) => {
			if (!alive) return;
			if (projects.status === 'fulfilled') setWorkspaces(projects.value);
			if (availableModels.status === 'fulfilled') setModels(availableModels.value);
			setCatalogError(projects.status === 'rejected' ? errorText(projects.reason) : availableModels.status === 'rejected' ? errorText(availableModels.reason) : null);
		});
		return () => { alive = false; unsubscribe(); };
	}, [bridge, retry]);
	async function perform(action: () => Promise<UiAutomationSnapshot>, close?: () => void, editing = false): Promise<void> {
		if (busyRef.current) return;
		busyRef.current = true; setBusy(true); setError(null); setEditorError(null);
		try {
			const value = await action();
			if (active.current) { setSnapshot((old) => value.revision >= old.revision ? value : old); close?.(); }
		} catch (cause) { if (active.current) (editing ? setEditorError : setError)(errorText(cause)); }
		finally { busyRef.current = false; if (active.current) setBusy(false); }
	}
	function create(template?: 'review' | 'summary' | 'tests') {
		setEditorError(null);
		setEditor({ name: template ? t(`automation.template.${template}.name`) : '', prompt: template ? t(`automation.template.${template}.prompt`) : '', cwd: cwd || workspaces[0] || '', model: null, thinkingLevel: null, schedule: { kind: 'weekly', days: WEEKDAYS, time: '09:00' }, timeZone: localZone(), enabled: true });
	}
	async function openRun(run: UiAutomationRun) {
		if (!run.sessionPath || run.status === 'running' || busyRef.current) return;
		busyRef.current = true; setBusy(true); setError(null);
		try { if (!await onOpenSession(run.cwd, run.sessionPath) && active.current) setError(t('automation.openFailed')); }
		catch (cause) { if (active.current) setError(errorText(cause)); }
		finally { busyRef.current = false; if (active.current) setBusy(false); }
	}
	const visible = snapshot.automations.filter((task) => (filter === 'all' || (filter === 'active' ? task.enabled : !task.enabled)) && `${task.name} ${task.prompt} ${task.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	const historyTask = snapshot.automations.find((task) => task.id === historyId);
	const history = snapshot.runs.filter((run) => historyId === 'all' || run.automationId === historyId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return <main className="pd-main pd-automation-page">
		<header className="pd-chat-header"><button className="pd-icon-button pd-header-sidebar-toggle" type="button" onClick={onToggleSidebar} aria-label={t('chat.toggleSidebar')}><Icon name="panel" /></button><div className="pd-automation-header-title"><Icon name="automation" width="16" height="16" /><span>{t('sidebar.automation')}</span></div></header>
		<div className="pd-automation-scroll"><div className="pd-automation-content">
			<div className="pd-automation-intro"><div><span className="pd-automation-eyebrow">{t('automation.eyebrow')}</span><h1>{t('automation.title')}</h1><p>{t('automation.description')}</p></div><button type="button" className="pd-automation-button is-primary" onClick={() => create()} disabled={!bridge || loading || busy}><Icon name="plus" width="16" height="16" />{t('automation.create')}</button></div>
			<div className="pd-automation-toolbar"><SegmentedIndicator className="pd-automation-filters" label={t('automation.filter')} activeKey={filter}>{(['all', 'active', 'paused'] as Filter[]).map((value) => <button key={value} type="button" data-segment-key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`automation.${value}`)}<span>{snapshot.automations.filter((task) => value === 'all' || (value === 'active' ? task.enabled : !task.enabled)).length}</span></button>)}</SegmentedIndicator><label className="pd-automation-search"><Icon name="search" width="15" height="15" /><input type="search" aria-label={t('automation.search')} placeholder={t('automation.search')} value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" className="pd-automation-button is-quiet" onClick={() => setHistoryId('all')} disabled={loading}><Icon name="clock" width="15" height="15" />{t('automation.history')}</button></div>
			{(error || snapshot.error || catalogError) && <div className="pd-automation-error" role="alert">{error || snapshot.error || catalogError}<button type="button" onClick={() => setRetry((value) => value + 1)} disabled={busy}>{t('automation.retry')}</button></div>}
			{loading ? <div className="pd-automation-empty" role="status">{t('automation.loading')}</div> : <>
				{!visible.length ? <div className="pd-automation-empty"><span className="pd-automation-empty-icon"><Icon name={snapshot.automations.length ? 'search' : 'automation'} width="26" height="26" /></span><h2>{t(snapshot.automations.length ? 'automation.noMatches' : 'automation.emptyTitle')}</h2><p>{t(snapshot.automations.length ? 'automation.noMatchesHint' : 'automation.emptyHint')}</p>{!snapshot.automations.length && <button type="button" className="pd-automation-button" onClick={() => create()} disabled={!bridge || busy}>{t('automation.createFirst')}<Icon name="arrowRight" width="15" height="15" /></button>}</div> : <div className="pd-automation-grid">{visible.map((task) => {
					const run = snapshot.runs.find((entry) => entry.automationId === task.id && entry.status === 'running');
					return <article className={`pd-automation-card${run ? ' is-running' : ''}`} key={task.id}><div className="pd-automation-card-heading"><span className="pd-automation-card-icon"><Icon name="automation" /></span><span className={`pd-automation-status is-${run ? 'running' : task.enabled ? 'active' : 'paused'}`}><i />{t(run ? 'automation.status.running' : task.enabled ? 'automation.active' : 'automation.paused')}</span><button type="button" className="pd-automation-button is-quiet" onClick={() => { setEditorError(null); setEditor(task); }} disabled={busy}>{t('automation.edit')}</button></div><button type="button" className="pd-automation-card-title" onClick={() => setHistoryId(task.id)}><h2>{task.name}</h2><Icon name="chevronRight" width="16" height="16" /></button><p className="pd-automation-prompt-preview">{task.prompt}</p><div className="pd-automation-card-meta"><span title={task.cwd}><Icon name="folder" width="14" height="14" />{pathLeaf(task.cwd)}</span><span title={task.timeZone}><Icon name="clock" width="14" height="14" />{scheduleLabel(task.schedule, locale, t, task.timeZone)}</span></div><p className="pd-automation-next">{task.enabled && task.nextRunAt ? t('automation.next', { time: dateLabel(task.nextRunAt, locale, task.timeZone), zone: task.timeZone }) : t(task.enabled ? 'automation.noNext' : 'automation.pausedHint')}</p><footer><button type="button" className="pd-automation-button" disabled={busy || !bridge} onClick={() => bridge && void perform(() => run ? bridge.cancelAutomationRun(run.id) : bridge.runAutomation(task.id))}><Icon name={run ? 'square' : 'arrowRight'} width="13" height="13" />{t(run ? 'automation.stop' : 'automation.run')}</button><button type="button" className="pd-automation-button is-quiet" disabled={busy || !bridge} onClick={() => bridge && void perform(() => bridge.setAutomationEnabled(task.id, !task.enabled))}>{t(task.enabled ? 'automation.pause' : 'automation.resume')}</button><button type="button" className="pd-automation-button is-quiet pd-automation-card-history" onClick={() => setHistoryId(task.id)}>{t('automation.history')}</button><button type="button" className="pd-icon-button" aria-label={t('automation.deleteNamed', { name: task.name })} title={t(run ? 'automation.stopBeforeDelete' : 'automation.delete')} disabled={busy || Boolean(run)} onClick={() => setDeleteTarget(task)}><Icon name="archive" width="15" height="15" /></button></footer></article>;
				})}</div>}
				{!query && filter === 'all' && <section className="pd-automation-templates"><div><h2>{t('automation.templates')}</h2><p>{t('automation.templatesHint')}</p></div><div className="pd-automation-template-grid">{(['review', 'summary', 'tests'] as const).map((template) => <button className="pd-automation-template" type="button" key={template} onClick={() => create(template)} disabled={!bridge || busy}><Icon name={template === 'review' ? 'gitBranch' : template === 'summary' ? 'file' : 'terminal'} width="20" height="20" /><strong>{t(`automation.template.${template}.name`)}</strong><span>{t(`automation.template.${template}.description`)}</span><Icon className="pd-automation-template-arrow" name="arrowUp" width="14" height="14" /></button>)}</div></section>}
			</>}
			<p className="pd-automation-local-note"><Icon name="clock" width="14" height="14" />{t('automation.localHint')}</p>
		</div></div>
		{editor && <AutomationEditor initial={editor} workspaces={workspaces} models={models} error={editorError} busy={busy} onClose={() => setEditor(null)} onSave={(input) => bridge && void perform(() => bridge.saveAutomation(input), () => setEditor(null), true)} />}
		{deleteTarget && <Modal title={t('automation.delete')} busy={busy} onClose={() => setDeleteTarget(null)} className="pd-automation-confirm"><div className="pd-automation-form-body"><p>{t('automation.deleteConfirm', { name: deleteTarget.name })}</p>{error && <p className="pd-automation-error" role="alert">{error}</p>}</div><footer><button type="button" className="pd-automation-button" disabled={busy} onClick={() => setDeleteTarget(null)}>{t('automation.cancel')}</button><button type="button" className="pd-automation-button is-danger" disabled={busy || !bridge} onClick={() => bridge && void perform(() => bridge.deleteAutomation(deleteTarget.id), () => setDeleteTarget(null))}>{t('automation.delete')}</button></footer></Modal>}
		{historyId && <Modal title={historyTask ? t('automation.taskHistory', { name: historyTask.name }) : t('automation.history')} onClose={() => setHistoryId(null)} busy={busy} className="pd-automation-history-dialog"><div className="pd-automation-history-body">{error && <p className="pd-automation-error" role="alert">{error}</p>}{historyTask && <p className="pd-automation-history-prompt">{historyTask.prompt}</p>}{!history.length ? <div className="pd-automation-empty"><Icon name="clock" width="26" height="26" /><h3>{t('automation.noRuns')}</h3><p>{t('automation.noRunsHint')}</p></div> : history.map((run) => <article className="pd-automation-run" key={run.id}><div className="pd-automation-run-heading"><span className={`pd-automation-status is-${run.status}`}><i />{t(`automation.status.${run.status}`)}</span><span>{dateLabel(run.startedAt, locale)}</span><span>{t(run.trigger === 'manual' ? 'automation.manual' : 'automation.scheduled')}</span></div><h3>{run.name}</h3>{run.summary && <p className="pd-automation-run-summary">{run.summary}</p>}{run.error && <p className="pd-automation-run-error">{run.error}</p>}<div className="pd-automation-run-actions"><span title={run.cwd}>{pathLeaf(run.cwd)}{run.finishedAt && ` · ${t('automation.finished', { time: dateLabel(run.finishedAt, locale) })}`}</span>{run.status === 'running' ? <button type="button" className="pd-automation-button" disabled={busy || !bridge} onClick={() => bridge && void perform(() => bridge.cancelAutomationRun(run.id))}><Icon name="square" width="12" height="12" />{t('automation.stop')}</button> : run.sessionPath && <button type="button" className="pd-automation-button" onClick={() => void openRun(run)} disabled={busy}>{t('automation.openConversation')}<Icon name="arrowRight" width="14" height="14" /></button>}</div></article>)}</div></Modal>}
	</main>;
}
