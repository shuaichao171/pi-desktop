import { CUA_PERMISSION_MESSAGE, CUA_PERMISSION_TITLE } from '../../../packages/agent/src/cua/permissions.ts';

// Built renderer only: no CUA backend or real desktop permissions are changed.
export default async function cuaPermissionScenarios(review) {
	await review.waitFor('window.__modelReview?.ready === true');
	await review.viewport(1440, 1000);
	await review.reducedMotion(true);
	await review.evaluate(`(() => { window.__cuaConsentResponses=[]; window.piDesktop.respondExtensionDialog=async (id,value) => { window.__cuaConsentResponses.push({id,value}); }; })()`);
	const emit = id => review.evaluate(`window.__modelReview.emit('onExtensionDialog', ${JSON.stringify({ id, kind: 'confirm', title: CUA_PERMISSION_TITLE, message: CUA_PERMISSION_MESSAGE })})`);
	await emit('cua-first');
	await review.waitFor(`document.querySelector('.pd-extension-request')?.textContent.includes(${JSON.stringify(CUA_PERMISSION_TITLE)})`);
	await review.assert(`window.__cuaConsentResponses.length===0 && document.querySelector('.pd-extension-request').textContent.includes('重新打开本对话也会保留授权') && document.querySelector('.pd-extension-request').textContent.includes('/cua off')`, 'The user sees the consent scope and revocation instructions before any approval is sent');
	await review.screenshot('cua-permission-desktop');
	await review.clickText('.pd-extension-request-actions button', '确定');
	await review.waitFor(`!document.querySelector('.pd-extension-request')`);
	await review.assert(`window.__cuaConsentResponses.length===1 && window.__cuaConsentResponses[0].value===true`, 'An explicit confirmation grants the conversation request');
	await review.viewport(540, 820);
	await emit('cua-new-conversation');
	await review.waitFor(`Boolean(document.querySelector('.pd-extension-request'))`);
	await review.assert(`(() => { const card=document.querySelector('.pd-extension-request'); const rect=card.getBoundingClientRect(); return rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight && card.scrollWidth<=card.clientWidth+1 && window.__cuaConsentResponses.length===1; })()`, 'The consent request remains readable in a narrow window without submitting itself');
	await review.screenshot('cua-permission-narrow');
	await review.clickText('.pd-extension-request-actions button', '取消');
	await review.waitFor(`!document.querySelector('.pd-extension-request')`);
	await review.assert(`window.__cuaConsentResponses.length===2 && window.__cuaConsentResponses[1].value===false`, 'Cancellation rejects the request explicitly');
}
