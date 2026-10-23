import { useMemo } from 'react';
import type { WorkspaceGitGraphCommit } from '@pidesktop/shared';
import { layoutGitGraph } from '../gitGraphLayout';
import { useT } from '../i18n';
import './gitGraph.css';
import { formatDate } from '../dateFormat';

const ROW_HEIGHT = 30;
const LANE_WIDTH = 14;
const DOT_RADIUS = 4;

/**
 * SVG commit graph for the workbench git tab (zcode git-graph style): lanes
 * colored per branch, dots per commit, curved edges for merges, and dashed
 * edges when parents fall outside the loaded window.
 */
export function GitHistoryGraph({ commits }: { commits: WorkspaceGitGraphCommit[] }) {
	const { t, locale } = useT();
	const layout = useMemo(() => layoutGitGraph(commits.map(commit => ({ hash: commit.hash, parents: commit.parents }))), [commits]);
	const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2 + 2;
	const rowY = (index: number) => index * ROW_HEIGHT + ROW_HEIGHT / 2;
	const height = commits.length * ROW_HEIGHT;
	const width = layout.laneCount * LANE_WIDTH + 4;

	return <div className="pd-git-graph" role="group" aria-label={t('workbench.history')}>
		<svg className="pd-git-graph-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
			{layout.edges.map((edge, index) => {
				const x1 = laneX(edge.fromLane), y1 = rowY(edge.fromIndex);
				const y2 = edge.loaded ? rowY(edge.toIndex) : height;
				const x2 = laneX(edge.toLane);
				const middle = (y1 + y2) / 2;
				const path = x1 === x2
					? `M ${x1} ${y1} L ${x2} ${y2}`
					: `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
				return <path key={index} className={`pd-git-edge lane-${edge.fromLane % 8}${edge.loaded ? '' : ' is-overflow'}`} d={path} />;
			})}
			{layout.lanes.map((lane, index) => {
				const commit = commits[index]!;
				const isHead = commit.refs.includes('HEAD');
				return <circle key={commit.hash} className={`pd-git-dot lane-${lane % 8}${isHead ? ' is-head' : ''}`} cx={laneX(lane)} cy={rowY(index)} r={isHead ? DOT_RADIUS + 1.5 : DOT_RADIUS}>
					<title>{`${commit.shortHash} ${commit.subject}`}</title>
				</circle>;
			})}
		</svg>
		<ul className="pd-git-graph-rows">
			{commits.map(commit => <li key={commit.hash} className={commit.refs.includes('HEAD') ? ' is-head' : ''} style={{ minHeight: ROW_HEIGHT }} title={`${commit.hash}\n${commit.author} · ${commit.date}`}>
				<code>{commit.shortHash}</code>
				<span className="pd-git-graph-subject">{commit.subject}</span>
				{commit.refs.length > 0 && <span className="pd-git-graph-refs">{commit.refs.map(ref => <span key={ref} className={`pd-git-ref${ref === 'HEAD' ? ' is-head' : ''}`}>{ref === 'HEAD' ? 'HEAD' : ref}</span>)}</span>}
				<small>{commit.author} · {formatDate(commit.date, locale)}</small>
			</li>)}
			{commits.length === 0 && <li className="pd-workbench-empty">{t('workbench.historyEmpty')}</li>}
		</ul>
	</div>;
}
