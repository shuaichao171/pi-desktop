import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * CA hygiene tests: the deprecated-root filter removes exactly the listed
 * eMudhra/emSign subjects and preserves everything else; application degrades
 * to a warning when the runtime lacks tls.setDefaultCACertificates.
 */

// Subject in both the multiline X509Certificate.subject form and RFC 2253
// comma form with different RDN order/casing — all must match the same entry.
const deprecatedSubjects = [
	'C=IN\nOU=emSign PKI\nO=eMudhra Technologies Limited\nCN=emSign ECC Root CA - G3',
	'cn=emsign root ca - c1,ou=emsign pki,o=eMudhra Inc,c=US',
	'C=US\nOU=emSign PKI\nO=eMudhra Inc\nCN=emSign ECC Root CA - C3',
];

const benignSubjects = [
	'C=US\nO=DigiCert Inc\nCN=DigiCert Global Root G2',
	'CN=ISRG Root X1,O=Internet Security Research Group,C=US',
	// Still trusted by root programs (Mozilla keeps it, Chrome undecided): must survive.
	'C=IN\nOU=emSign PKI\nO=eMudhra Technologies Limited\nCN=emSign Root CA - G1',
	// Similar names but different organizations/CNs: exact-subject matching must keep them.
	'CN=emSign Root CA - G1,OU=Private PKI,O=Example Corp,C=US',
	'CN=emSign Intermediate CA,O=eMudhra Technologies Limited,C=IN',
];

test('normalizeSubject tolerates separators, ordering, casing and escaped characters', async () => {
	const { normalizeSubject } = await import('../packages/desktop/src/main/caHygiene.ts');
	assert.equal(normalizeSubject('C=IN\nOU=emSign PKI\nO=eMudhra Technologies Limited\nCN=emSign Root CA - G1'),
		normalizeSubject('CN=emSign Root CA - G1,OU=emSign PKI,O=eMudhra Technologies Limited,C=IN'));
	assert.equal(normalizeSubject('CN=Entrust\\, Inc.,O=Example'), normalizeSubject('O=EXAMPLE,CN=Entrust\\, Inc.'));
	assert.notEqual(normalizeSubject('CN=Root A,O=Org'), normalizeSubject('CN=Root A,O=Other Org'));
});

test('isDeprecatedRootSubject matches exactly the eMudhra/emSign series, nothing more', async () => {
	const { isDeprecatedRootSubject, DEPRECATED_ROOT_SUBJECTS } = await import('../packages/desktop/src/main/caHygiene.ts');
	for (const subject of deprecatedSubjects) assert.equal(isDeprecatedRootSubject(subject), true, subject);
	for (const subject of benignSubjects) assert.equal(isDeprecatedRootSubject(subject), false, subject);
	// The list itself is written in oneline form and must match through normalization.
	assert.equal(DEPRECATED_ROOT_SUBJECTS.every((entry) => isDeprecatedRootSubject(entry)), true);
	assert.equal(DEPRECATED_ROOT_SUBJECTS.length, 3, 'only roots a root program removed or is retiring (G3, C1, C3), not G1');
});

test('pruneDeprecatedRoots removes exactly the listed roots and preserves the rest', async () => {
	const { pruneDeprecatedRoots } = await import('../packages/desktop/src/main/caHygiene.ts');
	const bySubject = new Map([...deprecatedSubjects, ...benignSubjects].map((subject, index) => [`pem-${index}`, subject]));
	const input = [...bySubject.keys()];
	// Certificates whose subject cannot be read stay: the filter never guesses.
	bySubject.set('pem-unparseable', null);
	input.push('pem-unparseable');
	const kept = pruneDeprecatedRoots(input, (certificate) => bySubject.get(certificate) ?? null);
	assert.deepEqual(kept.sort(), input.filter((certificate) => !deprecatedSubjects.includes(bySubject.get(certificate))).sort());
	assert.equal(kept.length, input.length - deprecatedSubjects.length);
});

test('pruneDeprecatedRoots drops the real eMudhra/emSign roots from the live default set', async () => {
	const tls = await import('node:tls');
	const { X509Certificate } = await import('node:crypto');
	const { pruneDeprecatedRoots, isDeprecatedRootSubject } = await import('../packages/desktop/src/main/caHygiene.ts');
	if (typeof tls.getCACertificates !== 'function') return; // older runtime: nothing to assert
	const defaults = tls.getCACertificates('default');
	const subjectOf = (certificate) => {
		try { return new X509Certificate(certificate).subject; } catch { return null; }
	};
	const pruned = pruneDeprecatedRoots(defaults);
	// No listed root survives the filter …
	for (const certificate of pruned) {
		const subject = subjectOf(certificate);
		assert.ok(subject === null || !isDeprecatedRootSubject(subject), 'no deprecated root survives');
	}
	// … and nothing else is removed: the survivors are exactly the non-listed defaults.
	const expectedSurvivors = defaults.filter((certificate) => {
		const subject = subjectOf(certificate);
		return subject === null || !isDeprecatedRootSubject(subject);
	});
	assert.deepEqual(pruned, expectedSurvivors);
	// On runtimes that still bundle the series (Node 24 does), the removed
	// certificates are precisely the eMudhra/emSign roots.
	const removed = defaults.filter((certificate) => !pruned.includes(certificate));
	for (const certificate of removed) assert.match(subjectOf(certificate) ?? '', /emSign|eMudhra/);
});

test('applyCaHygiene sets the pruned default set and reports removals', async () => {
	const { applyCaHygiene, DEPRECATED_ROOT_SUBJECTS } = await import('../packages/desktop/src/main/caHygiene.ts');
	const calls = [];
	const bySubject = new Map([...deprecatedSubjects, ...benignSubjects].map((subject, index) => [`pem-${index}`, subject]));
	const tls = {
		getCACertificates(type) {
			if (type === 'system' || type === 'extra') return [];
			assert.equal(type, 'default', 'only the default set is rebuilt');
			return [...bySubject.keys(), 'pem-unparseable'];
		},
		setDefaultCACertificates(certificates) { calls.push(certificates); },
	};
	const warnings = [];
	const result = applyCaHygiene(tls, (message) => warnings.push(message), (certificate) => bySubject.get(certificate) ?? null);
	assert.deepEqual(result, { applied: true, removed: deprecatedSubjects.length });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].length, benignSubjects.length + 1, 'benign + unparseable certificates survive');
	assert.deepEqual(warnings, [], 'success is silent');
	assert.equal(DEPRECATED_ROOT_SUBJECTS.length > 0, true);
});

test('a retired root that the system or extra store also trusts is kept (OS/user trust wins)', async () => {
	const { applyCaHygiene } = await import('../packages/desktop/src/main/caHygiene.ts');
	// Node's default set folds in the OS store (Windows by default, --use-system-ca)
	// and NODE_EXTRA_CA_CERTS: their certificates appear in "default" too.
	const bySubject = new Map([['pem-bundled-g3', deprecatedSubjects[0]], ['pem-system-c1', deprecatedSubjects[1]], ['pem-extra-c3', deprecatedSubjects[2]], ['pem-ok', benignSubjects[0]]]);
	const sets = { default: [...bySubject.keys()], system: ['pem-system-c1'], extra: ['pem-extra-c3'] };
	let installed = null;
	const result = applyCaHygiene({
		getCACertificates: (type) => sets[type],
		setDefaultCACertificates: (certificates) => { installed = certificates; },
	}, () => {}, (certificate) => bySubject.get(certificate) ?? null);
	assert.deepEqual(result, { applied: true, removed: 1 }, 'only the bundled-only retired root goes');
	assert.deepEqual(installed, ['pem-system-c1', 'pem-extra-c3', 'pem-ok']);
});

test('the live default set keeps every system and extra certificate it carries', async () => {
	const tls = await import('node:tls');
	const { applyCaHygiene } = await import('../packages/desktop/src/main/caHygiene.ts');
	if (typeof tls.getCACertificates !== 'function') return;
	// Whether "default" folds in the OS store depends on the Node version and flags
	// (Node 24 on Windows does by default, Node 22 does not): a system/extra
	// certificate that was never in the default set cannot be pruned from it, so
	// only the ones the default set actually carries must survive.
	const defaults = new Set(tls.getCACertificates('default'));
	let installed = null;
	applyCaHygiene({ getCACertificates: (type) => tls.getCACertificates(type), setDefaultCACertificates: (certificates) => { installed = certificates; } }, () => {});
	assert.ok(Array.isArray(installed));
	const kept = new Set(installed);
	for (const type of ['system', 'extra']) {
		for (const certificate of tls.getCACertificates(type)) {
			if (defaults.has(certificate)) assert.ok(kept.has(certificate), `a ${type} certificate was pruned`);
		}
	}
});

test('applyCaHygiene skips with only a warning when the API is missing or fails', async () => {
	const { applyCaHygiene } = await import('../packages/desktop/src/main/caHygiene.ts');
	const warnings = [];
	// Missing API (older Electron/Node runtime).
	const missing = applyCaHygiene({}, (message) => warnings.push(message));
	assert.deepEqual(missing, { applied: false, removed: 0 });
	assert.match(warnings[0], /tls.setDefaultCACertificates/);
	// Runtime error during rebuild: warn, do not throw, do not set anything.
	let setCalls = 0;
	const failing = applyCaHygiene({
		getCACertificates: () => { throw new Error('boom'); },
		setDefaultCACertificates: () => { setCalls += 1; },
	}, (message) => warnings.push(message));
	assert.deepEqual(failing, { applied: false, removed: 0 });
	assert.match(warnings[1], /boom/);
	assert.equal(setCalls, 0);
});
