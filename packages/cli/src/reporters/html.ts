// Self-contained HTML serializer for a ReportModel: one static document with inline CSS, no
// script and no external resource, so it opens from a file with nothing installed. Every
// interpolated string is HTML-escaped, including the Markdown copy inside the textarea.
import { renderMarkdown, type ReportModel } from './report.ts';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Fixed colours (white-on-colour contrast >= 4.5:1) for the badge names the model uses.
const BADGE_COLORS: Readonly<Record<string, string>> = {
  brightgreen: '#116329',
  yellow: '#7d4e00',
  orange: '#a03c00',
  red: '#b3261e',
  lightgrey: '#5b5f66',
};
const FALLBACK_BADGE_COLOR = BADGE_COLORS['lightgrey'] ?? '#5b5f66';

function badgeColor(name: string): string {
  return Object.hasOwn(BADGE_COLORS, name)
    ? (BADGE_COLORS[name] ?? FALLBACK_BADGE_COLOR)
    : FALLBACK_BADGE_COLOR;
}

const STYLE = `
body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1b1f24; background: #fff; }
h1 { font-size: 1.5rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #c9ced6; padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f2f4f7; }
td.num { text-align: right; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.badge { display: inline-block; padding: 0.1rem 0.6rem; border-radius: 0.25rem; color: #fff; font-weight: 600; }
.demo { border-left: 4px solid #5b5f66; background: #f2f4f7; padding: 0.5rem 1rem; }
.note { font-style: italic; }
footer { margin-top: 2rem; color: #4a5059; font-size: 0.9rem; }
textarea { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/** Pure: the same model always serializes to the same document. */
export function renderHtml(model: ReportModel): string {
  const e = escapeHtml;
  const { counts, calibration } = model;
  const showThreshold = model.criteria.some((c) => c.threshold !== undefined);
  const head = [
    'Criterion',
    'Wording',
    'Pass',
    'Fail',
    'Unscored',
    'Calibration',
    ...(showThreshold ? ['Threshold'] : []),
  ];
  const rows = model.criteria.map((c) => {
    const cells = [
      `<td><code>${e(c.id)}</code></td>`,
      `<td>${e(c.wording)}</td>`,
      `<td class="num">${String(c.passed)}</td>`,
      `<td class="num">${String(c.failed)}</td>`,
      `<td class="num">${String(c.unscored)}</td>`,
      `<td>${e(c.calibration)}</td>`,
      ...(showThreshold
        ? [`<td class="num">${c.threshold === undefined ? '' : String(c.threshold)}</td>`]
        : []),
    ];
    return `<tr>${cells.join('')}</tr>`;
  });
  const parts: string[] = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="vetkit ${e(model.vetkitVersion)}">`,
    `<title>${e(`vetkit eval report — ${String(counts.passed)}/${String(counts.total)} passed · ${calibration.label}`)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<h1>vetkit eval report</h1>',
  ];
  if (model.demo) {
    parts.push(
      '<p class="demo">demo run — verdicts come from the built-in demo judge and are not a quality claim.</p>',
    );
  }
  parts.push(
    `<p class="counts"><strong>${String(counts.passed)} passed · ${String(counts.failed)} failed · ${String(counts.unscored)} unscored</strong> of ${String(counts.total)}${counts.aborted ? ' (aborted)' : ''} · exit ${String(counts.exitCode)}</p>`,
    `<p>Calibration: ${e(calibration.label)}</p>`,
    `<p><span class="badge" style="background: ${badgeColor(model.badge.color)}">${e(model.badge.label)}: ${e(model.badge.message)}</span></p>`,
    `<p>Model: <code>${e(model.model.name)}</code> (transport ${e(model.model.transport)}, pinned: ${String(model.model.pinned)})</p>`,
  );
  if (model.model.pinnedNote !== undefined) {
    parts.push(`<p class="note">${e(model.model.pinnedNote)}</p>`);
  }
  if (model.gateReasons.length > 0) {
    parts.push(
      '<ul class="gate">',
      ...model.gateReasons.map((reason) => `<li>Gate refused: ${e(reason)}</li>`),
      '</ul>',
    );
  }
  parts.push(
    '<table>',
    `<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead>`,
    `<tbody>${rows.join('\n')}</tbody>`,
    '</table>',
  );
  if (model.failedCases.length > 0) {
    parts.push(
      '<p>Failed cases:</p>',
      '<ul>',
      ...model.failedCases.map((id) => `<li><code>${e(id)}</code></li>`),
      '</ul>',
    );
  }
  if (model.cases !== undefined) {
    parts.push(
      '<details open><summary>Cases</summary>',
      '<table>',
      '<thead><tr><th scope="col">Case</th><th scope="col">Outcome</th><th scope="col">State</th></tr></thead>',
      `<tbody>${model.cases
        .map(
          (c) =>
            `<tr><td><code>${e(c.id)}</code></td><td>${c.outcome}</td><td><pre>${e(c.state)}</pre></td></tr>`,
        )
        .join('\n')}</tbody>`,
      '</table>',
      '</details>',
    );
  }
  parts.push(
    '<footer>',
    `<p>Dataset <code>${e(model.datasetHash ?? 'unavailable')}</code> · vetkit ${e(model.vetkitVersion)} · started ${e(model.startedAt)} · <a href="${e(model.repoUrl)}" rel="noopener">vetkit</a></p>`,
    '</footer>',
    `<details><summary>Copy as Markdown</summary><textarea readonly rows="20">${e(renderMarkdown(model))}</textarea></details>`,
    '</body>',
    '</html>',
    '',
  );
  return parts.join('\n');
}
