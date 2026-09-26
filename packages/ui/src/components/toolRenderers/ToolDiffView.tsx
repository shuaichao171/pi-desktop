import { useMemo } from 'react';
import { parsePiEditDiff } from '../../unifiedDiff';

/**
 * Line-numbered rendering of Pi's edit-tool diff (`+3 added` / `-2 removed`
 * rows), reusing the workspace diff palette so session and workbench agree.
 */
export function ToolDiffView({ diff }: { diff: string }) {
	const lines = useMemo(() => parsePiEditDiff(diff), [diff]);
	return <div className="pd-activity-diff" tabIndex={0} role="region" aria-label="diff">
		<pre>{lines.map((line, index) => (
			<span className={`pd-diff-line is-${line.kind}`} key={index}>
				<span className="pd-diff-number" aria-hidden="true">{line.oldLine}</span>
				<span className="pd-diff-number" aria-hidden="true">{line.newLine}</span>
				<span className="pd-diff-text">{line.text || ' '}</span>
			</span>
		))}</pre>
	</div>;
}
