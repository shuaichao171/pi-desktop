export type SettingsDraftState = { dirty: boolean; saving: boolean; save?(): Promise<boolean> };
export type SettingsLeaveRequest<Page, Focus> = { action(): void; page: Page; focus: Focus };

/** One pending navigation owns its original page and focus until resolved. */
export function createSettingsLeaveGuard<Page, Focus>() {
	let draft: SettingsDraftState = { dirty: false, saving: false };
	let pending: SettingsLeaveRequest<Page, Focus> | null = null;
	let savingLeave = false;
	return {
		get pending() { return pending; },
		report(next: SettingsDraftState) { draft = { ...next }; },
		request(request: SettingsLeaveRequest<Page, Focus>): SettingsLeaveRequest<Page, Focus> | null {
			if (draft.saving || savingLeave || pending) return null;
			if (!draft.dirty) { request.action(); return null; }
			pending = request;
			return request;
		},
		keepEditing(): SettingsLeaveRequest<Page, Focus> | null {
			if (savingLeave) return null;
			const request = pending;
			pending = null;
			return request;
		},
		takeDiscard(): SettingsLeaveRequest<Page, Focus> | null {
			if (draft.saving || savingLeave) return null;
			const request = pending;
			pending = null;
			if (request) draft = { dirty: false, saving: false };
			return request;
		},
		async takeSaved(): Promise<SettingsLeaveRequest<Page, Focus> | null> {
			if (!pending || !draft.save || draft.saving || savingLeave) return null;
			const request = pending;
			const save = draft.save;
			savingLeave = true;
			try {
				if (!await save() || pending !== request) return null;
				pending = null;
				draft = { dirty: false, saving: false };
				return request;
			} finally { savingLeave = false; }
		},
	};
}
