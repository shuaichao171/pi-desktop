/**
 * CA hygiene: prune deprecated root certificates from Node's default CA set
 * (cf. Claude Desktop nodeHost — the bundled default set is rebuilt once at
 * startup with known-replaced roots removed, failures only warn).
 *
 * The deprecated list matches by exact normalized subject. Node's "default"
 * set is not just the bundled Mozilla store: it also folds in the OS trust
 * store (`--use-system-ca`, and on Windows by default) and NODE_EXTRA_CA_CERTS.
 * Any certificate that the system or extra set also carries is therefore kept:
 * an OS/user trust decision is never overridden, only Node's own bundled copy
 * of a retired root is dropped.
 */
import { X509Certificate } from 'node:crypto';
import * as nodeTls from 'node:tls';

/**
 * Subjects of roots that major root programs have actually removed or are
 * retiring, while Node still bundles them. Only list a root once a root program
 * has acted on it: removing a root that browsers still trust breaks sites that
 * work everywhere else.
 *
 * - emSign ECC Root CA - G3: removed from the Chrome Root Store and by Mozilla
 *   (2026-10) after the compromised-intermediate incident.
 * - emSign Root CA - C1 / emSign ECC Root CA - C3: being retired by Mozilla
 *   under eMudhra's own transition plan.
 * - Deliberately NOT listed: emSign Root CA - G1. Mozilla is not removing it
 *   and Chrome has not decided; add it only once a root program distrusts it.
 *
 * Normalize-insensitive exact matching; append entries as roots are retired.
 */
export const DEPRECATED_ROOT_SUBJECTS: readonly string[] = [
	'CN=emSign ECC Root CA - G3,OU=emSign PKI,O=eMudhra Technologies Limited,C=IN',
	'CN=emSign Root CA - C1,OU=emSign PKI,O=eMudhra Inc,C=US',
	'CN=emSign ECC Root CA - C3,OU=emSign PKI,O=eMudhra Inc,C=US',
];

const deprecatedSubjects = new Set(DEPRECATED_ROOT_SUBJECTS.map(normalizeSubject));

/**
 * Normalizes a certificate subject for comparison. Accepts both the
 * newline-separated (`X509Certificate.subject`) and RFC 2253 comma-separated
 * forms, unescapes `\-escaped` characters, uppercases and sorts the RDNs, so
 * ordering and casing differences between stores cannot hide a match.
 */
export function normalizeSubject(subject: string): string {
	const parts: string[] = [];
	let current = '';
	for (let index = 0; index < subject.length; index += 1) {
		const char = subject[index]!;
		if (char === '\\' && index + 1 < subject.length) {
			current += char + subject[++index];
			continue;
		}
		if (char === '\n' || char === ',') {
			parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts
		.map((part) => part.replace(/\\([,+"\\/])/g, '$1').replace(/\s+/g, ' ').trim().toUpperCase())
		.filter(Boolean)
		.sort()
		.join('|');
}

/** True only when the subject is exactly one of the deprecated root subjects. */
export function isDeprecatedRootSubject(subject: string): boolean {
	return deprecatedSubjects.has(normalizeSubject(subject));
}

/** Reads a PEM certificate's subject; unparseable input yields null (never guessed at). */
export function readCertificateSubject(certificate: string): string | null {
	try {
		return new X509Certificate(certificate).subject;
	} catch {
		return null;
	}
}

/**
 * Filters a CA list down to the non-deprecated roots. Certificates whose
 * subject cannot be read are always preserved — the list only ever removes
 * exact deprecated-subject matches — and so is every certificate in
 * `preserved` (the system/extra sets: OS and user trust decisions).
 */
export function pruneDeprecatedRoots(certificates: readonly string[], readSubject: (certificate: string) => string | null = readCertificateSubject, preserved: ReadonlySet<string> = new Set()): string[] {
	return certificates.filter((certificate) => {
		if (preserved.has(certificate)) return true;
		const subject = readSubject(certificate);
		return subject === null || !isDeprecatedRootSubject(subject);
	});
}

export interface CaHygieneResult {
	/** False when the runtime lacks the API or the rebuild failed (a warning was logged). */
	applied: boolean;
	/** How many deprecated roots were removed from the default set. */
	removed: number;
}

type CaTls = Pick<typeof nodeTls, 'getCACertificates' | 'setDefaultCACertificates'>;

/**
 * Rebuilds Node's default CA set without the deprecated roots. Applied once
 * per process at startup (main process and the Pi agent host utility
 * process); any failure only logs a warning and never blocks startup.
 */
export function applyCaHygiene(tls: CaTls = nodeTls, warn: (message: string) => void = (message) => console.warn(message), readSubject: (certificate: string) => string | null = readCertificateSubject): CaHygieneResult {
	const partial = tls as Partial<CaTls>;
	if (typeof partial.getCACertificates !== 'function' || typeof partial.setDefaultCACertificates !== 'function') {
		warn('CA 卫生：当前运行时不支持 tls.setDefaultCACertificates，已跳过 / CA hygiene skipped: tls.setDefaultCACertificates unavailable');
		return { applied: false, removed: 0 };
	}
	try {
		const defaults = partial.getCACertificates('default');
		if (!Array.isArray(defaults)) {
			warn('CA 卫生：默认 CA 集返回非数组，已跳过 / CA hygiene skipped: default set is not an array');
			return { applied: false, removed: 0 };
		}
		// The default set also carries system/extra CAs: those are trust decisions of
		// the OS or the user and must survive even when they repeat a retired root.
		const preserved = new Set<string>();
		for (const type of ['system', 'extra'] as const) {
			try {
				const list = partial.getCACertificates(type);
				if (Array.isArray(list)) for (const certificate of list) preserved.add(certificate);
			} catch { /* A missing store just protects nothing extra. */ }
		}
		const pruned = pruneDeprecatedRoots(defaults, readSubject, preserved);
		partial.setDefaultCACertificates(pruned);
		return { applied: true, removed: defaults.length - pruned.length };
	} catch (error) {
		warn(`CA 卫生：剔除废弃根证书失败 / CA hygiene failed: ${error instanceof Error ? error.message : String(error)}`);
		return { applied: false, removed: 0 };
	}
}
