import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UiAutomation, UiAutomationInput, UiAutomationRun, UiAutomationSchedule, UiAutomationSnapshot, UiModelSummary, UiThinkingLevel } from '@pidesktop/shared';
import { useChatStore } from '../store';
import { sidebarProjectPaths } from '../sidebarOrganization';
import { useT, type Locale, type Translate } from '../i18n';
import { managementCopy } from '../managementCopy';
import { automationRuns } from '../managementState';
import { INTERVAL_PRESETS, INTERVAL_UNIT_FACTOR, formatRunDuration, splitIntervalMinutes, supportedTimeZones, toIntervalMinutes, type IntervalUnit } from '../automationHelpers';
import { technicalInputAttributes } from '../technicalInputAttributes';
import { ConversationMarkdown } from './ConversationMarkdown';
import { HoverTooltip } from './HoverTooltip';
import { Icon } from './Icons';
import { SegmentedIndicator } from './SegmentedIndicator';
import './automationPage.css';
import { formatDate } from '../dateFormat';

const EMPTY: UiAutomationSnapshot = { revision: -1, automations: [], runs: [] };
const WEEKDAYS = [1, 2, 3, 4, 5];
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const LEVELS: UiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const UNITS: readonly IntervalUnit[] = ['minutes', 'hours', 'days'];
const UNIT_BOUNDS: Record<IntervalUnit, { min: number; max: number }> = {
	minutes: { min: 5, max: 43_200 },
	hours: { min: 1, max: 720 },
	days: { min: 1, max: 30 },
};
type Frequency = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'once';
type Filter = 'all' | 'active' | 'paused';
const pathLeaf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function dateLabel(value: string | null, locale: Locale, zone?: string): string {
	if (!value) return '—';
	return formatDate(value, locale, { time: true, timeZone: zone }) || value;
}
function dayLabel(day: number, locale: Locale): string {
	return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + day)));
}
function scheduleLabel(schedule: UiAutomationSchedule, locale: Locale, t: Translate, zone: string): string {
	if (schedule.kind === 'interval') {
		if (schedule.minutes >= 1440 && schedule.minutes % 1440 === 0) return t('automation.everyDays', { count: schedule.minutes / 1440 });
		if (schedule.minutes % 60 === 0) return t('automation.everyHours', { count: schedule.minutes / 60 });
		return t('automation.everyMinutes', { count: schedule.minutes });
	}
	if (schedule.kind === 'once') return t('automation.onceAt', { time: dateLabel(schedule.at, locale, zone) });
	const days = schedule.days.length === 7 ? t('automation.daily') : schedule.days.length === 5 && WEEKDAYS.every((day) => schedule.days.includes(day)) ? t('automation.weekdays') : DAYS.filter((day) => schedule.days.includes(day)).map((day) => dayLabel(day, locale)).join(' · ');
	return `${days} ${schedule.time}`;
}
function localInputDate(value: string): string {
	const date = new Date(value);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Native modal dialogs provide focus containment, backdrop dismissal, and stay hidden while another view is active. */
function Modal({ title, children, onClose, busy = false, active = true, className = '' }: { title: string; children: ReactNode; onClose(): void; busy?: boolean; active?: boolean; className?: string }) {
	const { t } = useT();
	const ref = useRef<HTMLDialogElement>(null);
	const id = useId();
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (active) {
			if (!dialog.open) {
				dialog.showModal();
				dialog.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)')?.focus();
			}
		} else if (dialog.open) {
			dialog.close();
		}
		return () => { if (dialog.open) dialog.close(); };
	}, [active]);
	return createPortal(<dialog
		ref={ref}
		className={`pd-automation-dialog ${className}`}
		role={active ? 'dialog' : undefined}
		aria-labelledby={id}
		aria-modal={active ? 'true' : undefined}
		hidden={!active}
		onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
		onClick={(event) => {
			if (busy || event.target !== event.currentTarget) return;
			const rect = event.currentTarget.getBoundingClientRect();
			if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
		}}
	>
		<header><h2 id={id}>{title}</h2><button type="button" className="pd-icon-button" aria-label={t('automation.close')} onClick={onClose} disabled={busy}><Icon name="close" /></button></header>
		{children}
	</dialog>, document.body);
}

function AutomationEditor({ initial, workspaces, models, busy, active, error, onSave, onClose }: { initial: UiAutomationInput; workspaces: string[]; models: UiModelSummary[]; busy: boolean; active: boolean; error: string | null; onSave(input: UiAutomationInput): void; onClose(): void }) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const zoneListId = useId();
	const timeZones = useMemo(() => supportedTimeZones(), []);
	const initialInterval = splitIntervalMinutes(initial.schedule.kind === 'interval' ? initial.schedule.minutes : 60);
	const [name, setName] = useState(initial.name);
	const [prompt, setPrompt] = useState(initial.prompt);
	const [cwd, setCwd] = useState(initial.cwd);
	const [modelKey, setModelKey] = useState(initial.model ? JSON.stringify([initial.model.provider, initial.model.id]) : '');
	const [thinking, setThinking] = useState<UiThinkingLevel | ''>(initial.thinkingLevel ?? '');
	const [enabled, setEnabled] = useState(initial.enabled);
	const [frequency, setFrequency] = useState<Frequency>(() => initial.schedule.kind !== 'weekly' ? initial.schedule.kind : initial.schedule.days.length === 7 ? 'daily' : initial.schedule.days.length === 5 && WEEKDAYS.every((day) => initial.schedule.kind === 'weekly' && initial.schedule.days.includes(day)) ? 'weekdays' : 'weekly');
	const [intervalValue, setIntervalValue] = useState(String(initialInterval.value));
	const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(initialInterval.unit);
	const [days, setDays] = useState(initial.schedule.kind === 'weekly' ? initial.schedule.days : WEEKDAYS);
	const [time, setTime] = useState(initial.schedule.kind === 'weekly' ? initial.schedule.time : '09:00');
	const [onceAt, setOnceAt] = useState(localInputDate(initial.schedule.kind === 'once' ? initial.schedule.at : new Date(Date.now() + 60 * 60_000).toISOString()));
	const [zone, setZone] = useState(initial.timeZone);
	const [grace, setGrace] = useState(initial.misfireGraceMinutes == null ? '' : String(initial.misfireGraceMinutes));
	const [runLimit, setRunLimit] = useState(initial.maxScheduledRuns == null ? '' : String(initial.maxScheduledRuns));
	const [retries, setRetries] = useState(String(initial.dispatchRetryLimit ?? 2));
	const [validation, setValidation] = useState<string | null>(null);
	const errorRef = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (validation || error) errorRef.current?.scrollIntoView({ block: 'nearest' });
	}, [validation, error]);

	const selectedModel = models.find((model) => JSON.stringify([model.provider, model.id]) === modelKey);
	const missingModel = modelKey && !selectedModel;
	const availableLevels = selectedModel?.thinkingLevels?.length ? selectedModel.thinkingLevels : LEVELS;
	const intervalMinutes = toIntervalMinutes(intervalValue, intervalUnit);
	const unitBounds = UNIT_BOUNDS[intervalUnit];
	const draftSchedule: UiAutomationSchedule | null = frequency === 'interval'
		? intervalMinutes !== null ? { kind: 'interval', minutes: intervalMinutes } : null
		: frequency === 'once' ? Number.isFinite(new Date(onceAt).getTime()) ? { kind: 'once', at: new Date(onceAt).toISOString() } : null
		: time && (frequency !== 'weekly' || days.length) ? { kind: 'weekly', time, days: frequency === 'daily' ? DAYS : frequency === 'weekdays' ? WEEKDAYS : days } : null;
	const currentLocalZone = localZone();
	const scheduleZone = frequency === 'once' ? currentLocalZone : zone;
	const hasCustomAdvanced = initial.misfireGraceMinutes != null || initial.maxScheduledRuns != null || (initial.dispatchRetryLimit ?? 2) !== 2;
	const advancedSummary = t('automation.advancedSummary', {
		grace: grace.trim() ? t('automation.graceMinutes', { count: grace.trim() }) : t('automation.unlimited'),
		limit: runLimit.trim() ? t('automation.runLimitCount', { count: runLimit.trim() }) : t('automation.unlimited'),
		retries: retries.trim() || '2',
	});

	function handleModelChange(nextKey: string) {
		setModelKey(nextKey);
		const nextModel = models.find((model) => JSON.stringify([model.provider, model.id]) === nextKey);
		if (nextModel && (!nextModel.reasoning || (nextModel.thinkingLevels?.length && thinking && !nextModel.thinkingLevels.includes(thinking)))) {
			setThinking('');
		}
	}

	function handleIntervalUnitChange(nextUnit: IntervalUnit) {
		const currentMinutes = toIntervalMinutes(intervalValue, intervalUnit);
		setIntervalUnit(nextUnit);
		const bounds = UNIT_BOUNDS[nextUnit];
		if (currentMinutes !== null) {
			const converted = Math.round(currentMinutes / INTERVAL_UNIT_FACTOR[nextUnit]);
			setIntervalValue(String(Math.max(bounds.min, Math.min(bounds.max, converted))));
		} else {
			setIntervalValue(String(nextUnit === 'minutes' ? 60 : 1));
		}
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setValidation(null);
		if (!name.trim() || !prompt.trim() || !cwd) { setValidation(t('automation.required')); return; }
		if (frequency === 'weekly' && !days.length) { setValidation(t('automation.chooseDay')); return; }
		if (frequency === 'interval' && intervalMinutes === null) { setValidation(t('automation.invalidInterval')); return; }
		const timeZone = frequency === 'once' ? currentLocalZone : zone.trim();
		try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { setValidation(t('automation.invalidZone')); return; }
		const at = new Date(onceAt);
		if (frequency === 'once' && (!Number.isFinite(at.getTime()) || (enabled && at.getTime() <= Date.now()))) { setValidation(t('automation.futureTime')); return; }
		const schedule: UiAutomationSchedule = frequency === 'interval' ? { kind: 'interval', minutes: intervalMinutes! } : frequency === 'once' ? { kind: 'once', at: at.toISOString() } : { kind: 'weekly', days: frequency === 'daily' ? DAYS : frequency === 'weekdays' ? WEEKDAYS : days, time };
		const [provider, modelId] = modelKey ? JSON.parse(modelKey) as [string, string] : ['', ''];
		onSave({ ...initial, name: name.trim(), prompt: prompt.trim(), cwd, model: modelKey ? { provider, id: modelId } : null, thinkingLevel: selectedModel && !selectedModel.reasoning ? null : thinking || null, schedule, timeZone, enabled, misfireGraceMinutes: grace ? Number(grace) : null, maxScheduledRuns: runLimit ? Number(runLimit) : null, dispatchRetryLimit: Number(retries) });
	}
	return <Modal title={t(initial.id ? 'automation.edit' : 'automation.create')} onClose={onClose} busy={busy} active={active}>
		<form onSubmit={submit} className="pd-automation-form">
			<div className="pd-automation-form-body">
				<section className="pd-automation-editor-section" aria-label={copy.taskSection}><h3>{copy.taskSection}</h3>
					<label className="pd-automation-field"><span>{t('automation.name')}</span><input data-autofocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('automation.namePlaceholder')} disabled={busy} /></label>
					<label className="pd-automation-field"><span>{t('automation.prompt')}</span><textarea required rows={5} maxLength={32000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('automation.promptPlaceholder')} disabled={busy} /><small>{t('automation.promptHint')}</small></label>
				</section>
				<section className="pd-automation-editor-section" aria-label={copy.projectSection}><h3>{copy.projectSection}</h3>
					<label className="pd-automation-field"><span>{t('automation.project')}</span><select required value={cwd} onChange={(event) => setCwd(event.target.value)} disabled={busy}><option value="">{t('automation.chooseProject')}</option>{[...new Set([...workspaces, ...(cwd ? [cwd] : [])])].map((path) => <option key={path} value={path}>{pathLeaf(path)} — {path}</option>)}</select>{!workspaces.length && <small>{t('automation.noProjects')}</small>}</label>
					<details className="pd-automation-model-options" open={Boolean(initial.model || initial.thinkingLevel)}><summary>{copy.options}<span>{selectedModel?.name || (modelKey ? initial.model?.id : t('automation.defaultModel'))} · {thinking ? t(`composer.thinking.${thinking}`) : t('automation.defaultThinking')}</span></summary><div className="pd-automation-field-pair">
						<label className="pd-automation-field"><span>{t('automation.model')}</span><select value={modelKey} onChange={(event) => handleModelChange(event.target.value)} disabled={busy}><option value="">{t('automation.defaultModel')}</option>{missingModel && <option value={modelKey}>{initial.model?.id} ({t('automation.unavailable')})</option>}{models.map((model) => <option key={JSON.stringify([model.provider, model.id])} value={JSON.stringify([model.provider, model.id])}>{model.name} · {model.provider}</option>)}</select></label>
						<label className="pd-automation-field"><span>{t('automation.thinking')}</span><select value={thinking} onChange={(event) => setThinking(event.target.value as UiThinkingLevel | '')} disabled={busy || Boolean(selectedModel && !selectedModel.reasoning)}><option value="">{t('automation.defaultThinking')}</option>{availableLevels.map((level) => <option key={level} value={level}>{t(`composer.thinking.${level}`)}</option>)}</select></label>
					</div></details>
				</section>
				<section className="pd-automation-editor-section pd-automation-schedule-fields" aria-label={copy.timeSection}><h3>{copy.timeSection}</h3>
					<p className="pd-automation-schedule-summary" aria-live="polite"><strong>{copy.plan}</strong><span>{draftSchedule ? scheduleLabel(draftSchedule, locale, t, scheduleZone) : copy.invalidPlan}</span><span>{t('automation.timeZone')}: {scheduleZone || '—'}</span></p>
					<div className="pd-automation-field-pair">
						<label className="pd-automation-field"><span>{t('automation.frequency')}</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as Frequency)} disabled={busy}>{(['daily', 'weekdays', 'weekly', 'interval', 'once'] as Frequency[]).map((value) => <option key={value} value={value}>{t(`automation.${value}`)}</option>)}</select></label>
						{frequency === 'interval' ? (
							<div className="pd-automation-field">
								<span>{t('automation.intervalValue')}</span>
								<div className="pd-automation-interval-input">
									<input type="number" required min={unitBounds.min} max={unitBounds.max} step={1} value={intervalValue} aria-label={t('automation.intervalValue')} onChange={(event) => setIntervalValue(event.target.value)} disabled={busy} />
									<select aria-label={t('automation.intervalUnit')} value={intervalUnit} onChange={(event) => handleIntervalUnitChange(event.target.value as IntervalUnit)} disabled={busy}>
										{UNITS.map((unit) => <option key={unit} value={unit}>{t(`automation.unit.${unit}`)}</option>)}
									</select>
								</div>
							</div>
						) : frequency === 'once' ? (
							<label className="pd-automation-field"><span>{t('automation.localDate')}</span><input type="datetime-local" required value={onceAt} onChange={(event) => setOnceAt(event.target.value)} disabled={busy} /></label>
						) : (
							<label className="pd-automation-field"><span>{t('automation.time')}</span><input type="time" required value={time} onChange={(event) => setTime(event.target.value)} disabled={busy} /></label>
						)}
					</div>
					{frequency === 'interval' && <div className="pd-automation-interval-presets" role="group" aria-label={t('automation.intervalValue')}>
						{INTERVAL_PRESETS.map((preset) => <button key={preset.minutes} type="button" className="pd-btn is-sm" aria-pressed={intervalMinutes === preset.minutes} disabled={busy} onClick={() => { setIntervalUnit(preset.unit); setIntervalValue(String(preset.value)); }}>{scheduleLabel({ kind: 'interval', minutes: preset.minutes }, locale, t, scheduleZone)}</button>)}
					</div>}
					{frequency === 'weekly' && <fieldset className="pd-automation-days"><legend>{t('automation.days')}</legend>{DAYS.map((day) => <button key={day} type="button" aria-pressed={days.includes(day)} onClick={() => setDays((old) => old.includes(day) ? old.filter((value) => value !== day) : [...old, day])} disabled={busy}>{dayLabel(day, locale)}</button>)}</fieldset>}
					<div className="pd-automation-field">
						<span>{t('automation.timeZone')}</span>
						<div className="pd-automation-zone-row">
							<input required list={zoneListId} value={frequency === 'once' ? currentLocalZone : zone} onChange={(event) => setZone(event.target.value)} disabled={busy || frequency === 'once'} placeholder="Asia/Shanghai" {...technicalInputAttributes} />
							{frequency !== 'once' && zone.trim() !== currentLocalZone && <button type="button" className="pd-btn is-sm is-ghost" disabled={busy} onClick={() => setZone(currentLocalZone)}>{t('automation.resetLocalZone')}</button>}
						</div>
						<datalist id={zoneListId}>{timeZones.map((item) => <option key={item} value={item} />)}</datalist>
					</div>
					<details className="pd-automation-model-options pd-automation-advanced-options" open={hasCustomAdvanced}>
						<summary>{t('automation.advancedSchedule')}<span>{advancedSummary}</span></summary>
						<div>
							<div className="pd-automation-field-pair">
								<label className="pd-automation-field"><span>{t('automation.grace')}</span><input type="number" min={1} max={525600} value={grace} onChange={(event) => setGrace(event.target.value)} disabled={busy} placeholder={t('automation.unlimited')} /><small>{t('automation.graceHint')}</small></label>
								<label className="pd-automation-field"><span>{t('automation.runLimit')}</span><input type="number" min={1} max={100000} value={runLimit} onChange={(event) => setRunLimit(event.target.value)} disabled={busy} placeholder={t('automation.unlimited')} /><small>{t('automation.runLimitHint')}</small></label>
							</div>
							<label className="pd-automation-field"><span>{t('automation.dispatchRetries')}</span><input type="number" required min={0} max={5} value={retries} onChange={(event) => setRetries(event.target.value)} disabled={busy} /><small>{t('automation.dispatchRetriesHint')}</small></label>
						</div>
					</details>
				</section>
				<label className="pd-automation-enable"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} /><span>{t('automation.enableAfterSave')}</span></label>
				<p className="pd-automation-local-note"><Icon name="clock" width="14" height="14" />{t('automation.localHint')}</p>
				{(validation || error) && <p ref={errorRef} role="alert" className="pd-automation-error">{validation || error}</p>}
			</div>
			<footer><button className="pd-btn pd-automation-button" type="button" onClick={onClose} disabled={busy}>{t('automation.cancel')}</button><button className="pd-btn pd-automation-button is-primary" type="submit" disabled={busy || !cwd}>{t(busy ? 'automation.saving' : 'automation.save')}</button></footer>
		</form>
	</Modal>;
}

export function AutomationPage({ onOpenSession, active = true }: { onOpenSession(cwd: string, path: string): Promise<boolean>; active?: boolean }) {
	const { t, locale } = useT();
	const copy = managementCopy(locale);
	const bridge = useChatStore((state) => state.bridge);
	const cwd = useChatStore((state) => state.cwd);
	const storedWorkspaces = useChatStore((state) => state.workspaces);
	const conversationWorkspaces = useChatStore((state) => state.conversationWorkspaces);
	const storedModels = useChatStore((state) => state.models);
	const [snapshot, setSnapshot] = useState(EMPTY);
	const [models, setModels] = useState(storedModels);
	const [workspaces, setWorkspaces] = useState(storedWorkspaces);
	const projects = sidebarProjectPaths(workspaces, null, conversationWorkspaces);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<Filter>('all');
	const [pendingKey, setPendingKey] = useState<string | null>(null);
	const [editor, setEditor] = useState<UiAutomationInput | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<UiAutomation | null>(null);
	const [historyId, setHistoryId] = useState<string | 'all' | null>(null);
	const [historyFilter, setHistoryFilter] = useState<UiAutomationRun['status'] | 'all'>('all');
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const historyBody = useRef<HTMLDivElement>(null);
	const [retry, setRetry] = useState(0);
	const mounted = useRef(false);
	const busyRef = useRef(false);
	const busy = pendingKey !== null;

	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
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
		void Promise.allSettled([bridge.listWorkspaces(), bridge.listModels()]).then(([projectList, availableModels]) => {
			if (!alive) return;
			if (projectList.status === 'fulfilled') setWorkspaces(projectList.value);
			if (availableModels.status === 'fulfilled') setModels(availableModels.value);
			setCatalogError(projectList.status === 'rejected' ? errorText(projectList.reason) : availableModels.status === 'rejected' ? errorText(availableModels.reason) : null);
		});
		return () => { alive = false; unsubscribe(); };
	}, [bridge, retry]);

	async function perform(action: () => Promise<UiAutomationSnapshot>, key: string, close?: () => void, editing = false): Promise<void> {
		if (busyRef.current) return;
		busyRef.current = true; setPendingKey(key); setError(null); setEditorError(null);
		try {
			const value = await action();
			if (mounted.current) { setSnapshot((old) => value.revision >= old.revision ? value : old); close?.(); }
		} catch (cause) { if (mounted.current) (editing ? setEditorError : setError)(errorText(cause)); }
		finally { busyRef.current = false; if (mounted.current) setPendingKey(null); }
	}
	function create(template?: 'review' | 'summary' | 'tests') {
		setEditorError(null);
		setEditor({ name: template ? t(`automation.template.${template}.name`) : '', prompt: template ? t(`automation.template.${template}.prompt`) : '', cwd: projects.includes(cwd) ? cwd : projects[0] || '', model: null, thinkingLevel: null, schedule: { kind: 'weekly', days: WEEKDAYS, time: '09:00' }, timeZone: localZone(), enabled: true });
	}
	async function openRun(run: UiAutomationRun) {
		if (!run.sessionPath || run.status === 'running' || busyRef.current) return;
		busyRef.current = true; setPendingKey(`open:${run.id}`); setError(null);
		try {
			const opened = await onOpenSession(run.cwd, run.sessionPath);
			if (mounted.current) {
				if (opened) setHistoryId(null);
				else setError(t('automation.openFailed'));
			}
		} catch (cause) { if (mounted.current) setError(errorText(cause)); }
		finally { busyRef.current = false; if (mounted.current) setPendingKey(null); }
	}

	const taskById = useMemo(() => new Map(snapshot.automations.map((task) => [task.id, task])), [snapshot.automations]);
	const modelByKey = useMemo(() => new Map(models.map((model) => [JSON.stringify([model.provider, model.id]), model])), [models]);
	const visible = snapshot.automations.filter((task) => (filter === 'all' || (filter === 'active' ? task.enabled : !task.enabled)) && `${task.name} ${task.prompt} ${task.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	const historyTask = historyId && historyId !== 'all' ? taskById.get(historyId) : undefined;
	const history = automationRuns(snapshot.runs, historyId ?? 'all', historyFilter);
	function showHistory(id: string, runId?: string) { setHistoryFilter('all'); setSelectedRunId(runId ?? null); setHistoryId(id); }
	useEffect(() => {
		if (!historyId || !selectedRunId || !active) return;
		const row = [...(historyBody.current?.querySelectorAll<HTMLElement>('[data-run-id]') ?? [])].find((entry) => entry.dataset.runId === selectedRunId);
		row?.scrollIntoView({ block: 'center' }); row?.focus({ preventScroll: true });
	}, [historyId, selectedRunId, active]);

	return <main className="pd-main pd-automation-page">
		<div className="pd-automation-scroll"><div className="pd-automation-content">
			<div className="pd-automation-intro"><div><span className="pd-automation-eyebrow">{t('automation.eyebrow')}</span><h1>{t('automation.title')}</h1><p>{t('automation.description')}</p></div><button type="button" className="pd-btn pd-automation-button is-primary" onClick={() => create()} disabled={!bridge || loading || busy}><Icon name="plus" width="16" height="16" />{t('automation.create')}</button></div>
			<div className="pd-automation-toolbar"><SegmentedIndicator className="pd-automation-filters pd-seg" label={t('automation.filter')} activeKey={filter}>{(['all', 'active', 'paused'] as Filter[]).map((value) => <button key={value} type="button" data-segment-key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`automation.${value}`)}<span>{snapshot.automations.filter((task) => value === 'all' || (value === 'active' ? task.enabled : !task.enabled)).length}</span></button>)}</SegmentedIndicator><label className="pd-automation-search"><Icon name="search" width="15" height="15" /><input type="search" aria-label={t('automation.search')} placeholder={t('automation.search')} value={query} onChange={(event) => setQuery(event.target.value)} /></label><button type="button" className="pd-btn pd-automation-button is-ghost" onClick={() => showHistory('all')} disabled={loading}><Icon name="clock" width="15" height="15" />{t('automation.history')}</button></div>
			{(error || snapshot.error || catalogError) && <div className="pd-automation-error" role="alert">{error || snapshot.error || catalogError}<button type="button" onClick={() => setRetry((value) => value + 1)} disabled={busy}>{t('automation.retry')}</button></div>}
			{loading ? <div className="pd-automation-empty" role="status">{t('automation.loading')}</div> : <>
				{!visible.length ? <div className="pd-automation-empty"><span className="pd-automation-empty-icon"><Icon name={snapshot.automations.length ? 'search' : 'automation'} width="26" height="26" /></span><h2>{t(snapshot.automations.length ? 'automation.noMatches' : 'automation.emptyTitle')}</h2><p>{t(snapshot.automations.length ? 'automation.noMatchesHint' : 'automation.emptyHint')}</p>{!snapshot.automations.length && <button type="button" className="pd-btn pd-automation-button" onClick={() => create()} disabled={!bridge || busy}>{t('automation.createFirst')}<Icon name="arrowRight" width="15" height="15" /></button>}</div> : <div className="pd-automation-grid">{visible.map((task) => {
					const taskRuns = automationRuns(snapshot.runs, task.id);
					const run = taskRuns.find((entry) => (entry.status === 'running' || entry.status === 'retrying'));
					const latest = taskRuns.find((entry) => (entry.status !== 'running' && entry.status !== 'retrying'));
					const taskModel = task.model ? modelByKey.get(JSON.stringify([task.model.provider, task.model.id])) : undefined;
					const modelBadge = task.model || task.thinkingLevel ? [task.model ? (taskModel?.name || task.model.id) : t('automation.defaultModel'), task.thinkingLevel ? t(`composer.thinking.${task.thinkingLevel}`) : null].filter(Boolean).join(' · ') : null;
					const runPending = pendingKey === `run:${task.id}`;
					const togglePending = pendingKey === `toggle:${task.id}`;
					return <article className={`pd-automation-card${run ? (run.status === 'retrying' ? ' is-retrying' : ' is-running') : ''}`} key={task.id}>
						<div className="pd-automation-card-heading">
							<span className="pd-automation-card-icon"><Icon name="automation" /></span>
							<span className={`pd-automation-status is-${task.completedAt ? 'completed' : task.enabled ? 'active' : 'paused'}`}><i />{t(task.completedAt ? 'automation.completed' : task.enabled ? 'automation.active' : 'automation.paused')}</span>
							<HoverTooltip title={t('automation.edit')} align="end">
								<button type="button" className="pd-icon-button pd-automation-card-edit" aria-label={t('automation.edit')} onClick={() => { setEditorError(null); setEditor(task); }} disabled={busy}><Icon name="pencil" width="14" height="14" /></button>
							</HoverTooltip>
						</div>
						<button type="button" className="pd-automation-card-title" onClick={() => showHistory(task.id)}><h2>{task.name}</h2><Icon name="chevronRight" width="16" height="16" /></button>
						<p className="pd-automation-prompt-preview">{task.prompt}</p>
						<div className="pd-automation-card-meta">
							<span title={task.cwd}><Icon name="folder" width="14" height="14" />{pathLeaf(task.cwd)}</span>
							<span title={task.timeZone}><Icon name="clock" width="14" height="14" />{scheduleLabel(task.schedule, locale, t, task.timeZone)}</span>
							{modelBadge && <span className="pd-automation-card-model" title={task.model ? `${task.model.provider} / ${task.model.id}` : modelBadge}><Icon name="spark" width="14" height="14" />{modelBadge}</span>}
						</div>
						<div className="pd-automation-card-status">
							{run && <span className={`pd-automation-status is-${run.status} pd-automation-run-state`}><i />{t(`automation.status.${run.status}`)}</span>}
							{latest ? <button type="button" className={`pd-automation-latest is-${latest.status}`} onClick={() => showHistory(task.id, latest.id)}><span>{copy.latestRun} · {t(`automation.status.${latest.status}`)}</span><time dateTime={latest.finishedAt || latest.startedAt}>{dateLabel(latest.finishedAt || latest.startedAt, locale, task.timeZone)}</time><Icon name="chevronRight" width="14" height="14" /></button> : !run && <p className="pd-automation-never-run">{copy.neverRun}</p>}
						</div>
						<p className="pd-automation-next">
							<span>{t('automation.count', { count: task.scheduledRunCount ?? 0 })}{task.maxScheduledRuns ? ` / ${task.maxScheduledRuns}` : ''}</span>
							<span>{task.completedAt ? t('automation.completedHint') : task.enabled && task.nextRunAt ? t('automation.next', { time: dateLabel(task.nextRunAt, locale, task.timeZone), zone: task.timeZone }) : t(task.enabled ? 'automation.noNext' : 'automation.pausedHint')}</span>
						</p>
						<footer>
							<button type="button" className={`pd-btn is-sm pd-automation-button${runPending ? ' is-pending' : ''}`} aria-busy={runPending || undefined} disabled={busy || !bridge} onClick={() => bridge && void perform(() => run ? bridge.cancelAutomationRun(run.id) : bridge.runAutomation(task.id), `run:${task.id}`)}><Icon name={runPending ? 'loader' : run ? 'square' : 'play'} width="13" height="13" />{t(run ? 'automation.stop' : 'automation.run')}</button>
							<button type="button" className={`pd-btn is-sm pd-automation-button${togglePending ? ' is-pending' : ''}`} aria-busy={togglePending || undefined} disabled={busy || !bridge || Boolean(task.completedAt)} title={task.completedAt ? t('automation.completedHint') : undefined} onClick={() => bridge && void perform(() => bridge.setAutomationEnabled(task.id, !task.enabled), `toggle:${task.id}`)}>{togglePending && <Icon name="loader" width="13" height="13" />}{t(task.enabled ? 'automation.pause' : 'automation.resume')}</button>
							<button type="button" className="pd-btn is-sm pd-automation-button is-ghost pd-automation-card-history" onClick={() => showHistory(task.id)}><Icon name="clock" width="13" height="13" />{t('automation.history')}</button>
							<HoverTooltip title={t(run ? 'automation.stopBeforeDelete' : 'automation.delete')} align="end">
								<button type="button" className="pd-icon-button pd-automation-card-delete" aria-label={t('automation.deleteNamed', { name: task.name })} disabled={busy || Boolean(run)} onClick={() => setDeleteTarget(task)}><Icon name="trash" width="14" height="14" /></button>
							</HoverTooltip>
						</footer>
					</article>;
				})}</div>}
				{!query && filter === 'all' && <section className="pd-automation-templates"><div><h2>{t('automation.templates')}</h2><p>{t('automation.templatesHint')}</p></div><div className="pd-automation-template-grid">{(['review', 'summary', 'tests'] as const).map((template) => <button className="pd-automation-template" type="button" key={template} onClick={() => create(template)} disabled={!bridge || busy}><Icon name={template === 'review' ? 'gitBranch' : template === 'summary' ? 'file' : 'terminal'} width="20" height="20" /><strong>{t(`automation.template.${template}.name`)}</strong><span>{t(`automation.template.${template}.description`)}</span><Icon className="pd-automation-template-arrow" name="arrowUp" width="14" height="14" /></button>)}</div></section>}
			</>}
			<p className="pd-automation-local-note"><Icon name="clock" width="14" height="14" />{t('automation.localHint')}</p>
		</div></div>
		{editor && <AutomationEditor initial={editor} workspaces={projects} models={models} error={editorError} busy={busy} active={active} onClose={() => setEditor(null)} onSave={(input) => bridge && void perform(() => bridge.saveAutomation(input), 'save', () => setEditor(null), true)} />}
		{deleteTarget && <Modal title={t('automation.delete')} busy={busy} active={active} onClose={() => setDeleteTarget(null)} className="pd-automation-confirm"><div className="pd-automation-form-body"><p>{t('automation.deleteConfirm', { name: deleteTarget.name })}</p>{error && <p className="pd-automation-error" role="alert">{error}</p>}</div><footer><button type="button" className="pd-btn pd-automation-button" disabled={busy} onClick={() => setDeleteTarget(null)}>{t('automation.cancel')}</button><button type="button" className={`pd-btn pd-automation-button is-danger${pendingKey === `delete:${deleteTarget.id}` ? ' is-pending' : ''}`} aria-busy={pendingKey === `delete:${deleteTarget.id}` || undefined} disabled={busy || !bridge} onClick={() => bridge && void perform(() => bridge.deleteAutomation(deleteTarget.id), `delete:${deleteTarget.id}`, () => setDeleteTarget(null))}>{t('automation.delete')}</button></footer></Modal>}
		{historyId && <Modal title={historyTask ? t('automation.taskHistory', { name: historyTask.name }) : t('automation.history')} onClose={() => setHistoryId(null)} busy={busy} active={active} className="pd-automation-history-dialog"><div className="pd-automation-history-body" ref={historyBody}>
			<label className="pd-automation-history-filter">{copy.resultFilter}<select value={historyFilter} onChange={(event) => { setHistoryFilter(event.target.value as typeof historyFilter); setSelectedRunId(null); }}><option value="all">{copy.allResults}</option>{(['running', 'retrying', 'skipped', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const).map((value) => <option key={value} value={value}>{t(`automation.status.${value}`)}</option>)}</select></label>
			{error && <p className="pd-automation-error" role="alert">{error}</p>}
			{historyTask && <p className="pd-automation-history-prompt">{historyTask.prompt}</p>}
			{!history.length ? <div className="pd-automation-empty"><Icon name="clock" width="26" height="26" /><h3>{t('automation.noRuns')}</h3><p>{t('automation.noRunsHint')}</p></div> : history.map((run) => {
				const runZone = historyTask?.timeZone ?? taskById.get(run.automationId)?.timeZone;
				const duration = formatRunDuration(run.startedAt, run.finishedAt, locale);
				const cancelPending = pendingKey === `cancel:${run.id}`;
				const openPending = pendingKey === `open:${run.id}`;
				return <article className={`pd-automation-run${selectedRunId === run.id ? ' is-selected' : ''}`} data-run-id={run.id} tabIndex={-1} key={run.id}>
					<div className="pd-automation-run-heading">
						<span className={`pd-automation-status is-${run.status}`}><i />{t(`automation.status.${run.status}`)}</span>
						<span>{dateLabel(run.startedAt, locale, runZone)}</span>
						{duration && <span className="pd-automation-run-duration">{t('automation.duration', { value: duration })}</span>}
						<span>{t(run.trigger === 'manual' ? 'automation.manual' : 'automation.scheduled')}</span>
					</div>
					<h3>{run.name}</h3>
					<p>{t('automation.attempts', { count: run.attempts ?? 1 })}{run.scheduledAt && ` · ${t('automation.scheduled')}: ${dateLabel(run.scheduledAt, locale, runZone)}`}{run.retryAt && ` · ${t('automation.status.retrying')}: ${dateLabel(run.retryAt, locale, runZone)}`}</p>
					{run.summary && <div className="pd-automation-run-summary pd-markdown"><ConversationMarkdown>{run.summary}</ConversationMarkdown></div>}
					{run.error && <p className="pd-automation-run-error">{run.error}</p>}
					<div className="pd-automation-run-actions">
						<span title={run.cwd}>{pathLeaf(run.cwd)}{run.finishedAt && ` · ${t('automation.finished', { time: dateLabel(run.finishedAt, locale, runZone) })}`}</span>
						{(run.status === 'running' || run.status === 'retrying')
							? <button type="button" className={`pd-btn pd-automation-button${cancelPending ? ' is-pending' : ''}`} aria-busy={cancelPending || undefined} disabled={busy || !bridge} onClick={() => bridge && void perform(() => bridge.cancelAutomationRun(run.id), `cancel:${run.id}`)}><Icon name={cancelPending ? 'loader' : 'square'} width="12" height="12" />{t('automation.stop')}</button>
							: run.sessionPath && <button type="button" className={`pd-btn pd-automation-button${openPending ? ' is-pending' : ''}`} aria-busy={openPending || undefined} onClick={() => void openRun(run)} disabled={busy}>{t('automation.openConversation')}<Icon name={openPending ? 'loader' : 'arrowRight'} width="14" height="14" /></button>}
					</div>
				</article>;
			})}
		</div></Modal>}
	</main>;
}
