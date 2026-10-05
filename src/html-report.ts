import { describePackageManager, describePackageManagerDetails } from './package-manager';
import { ruleText } from './policy';
import {
  fileBaseName,
  isLinkable,
  licenseFileName,
  licenseLabel,
  REPORT_FIELDS,
  type ReportMeta,
  reportDate,
  reportRows,
  reportTitle,
  summarize,
} from './report-model';
import type { LicenseReport, PackageEntry } from './types';

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// defined once (`<symbol>`), used by every copy button
const COPY_ICON =
  '<svg class="ic" width="14" height="14" aria-hidden="true" focusable="false"><use href="#i-copy"/></svg>';
const ICON_SPRITE =
  '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></symbol></svg>';

/**
 * A license file is shown by its file name. The link opens the copy in `licenses/` in the side drawer
 * (it is also a plain link, so it works without JavaScript); the button copies the complete original path.
 */
const licenseFileCell = (entry: PackageEntry): string => {
  const path = String(entry['license file'] ?? '');
  const pkg = `${entry['package name']}@${entry['package version']}`;
  const href = `licenses/${encodeURIComponent(licenseFileName(entry))}`;
  return (
    `<a class="lic" href="${escapeHtml(href)}" data-pkg="${escapeHtml(pkg)}" title="${escapeHtml(path)}">${escapeHtml(fileBaseName(path))}</a>` +
    `<button type="button" class="copy" data-path="${escapeHtml(path)}" title="Copy complete path" aria-label="Copy complete path of ${escapeHtml(pkg)}">${COPY_ICON}</button>`
  );
};

const cell = (field: keyof PackageEntry, entry: PackageEntry): string => {
  const value = entry[field];
  const text = String(value ?? '');
  if (field === 'license file' && text && text !== 'none') return licenseFileCell(entry);
  if (field === 'download url' && isLinkable(text)) {
    return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
  }
  if (field === 'dependencyType') {
    return `<span class="badge ${text === 'direct' ? 'imm' : 'trn'}">${escapeHtml(text)}</span>`;
  }
  return escapeHtml(text);
};

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--muted:#5b6678;--line:#dfe3ea;--accent:#2457d6;--bad:#b3261e;--badbg:#fdecea;--imm:#1d6b3a;--immbg:#e3f4ea;--trn:#6b4e00;--trnbg:#fff3d6}
@media (prefers-color-scheme:dark){:root{--bg:#10141b;--card:#171c26;--fg:#e6e9ef;--muted:#9aa5b8;--line:#2a3243;--accent:#7aa2ff;--bad:#ff8a80;--badbg:#3a1d1b;--imm:#7fd9a0;--immbg:#173222;--trn:#f2cc6b;--trnbg:#352b10}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header,main{max-width:1500px;margin:0 auto;padding:16px 24px}h1{margin:8px 0 2px;font-size:22px}.sub{color:var(--muted);margin:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:24px}.card span{color:var(--muted)}
.card.bad{border-color:var(--bad)}.card.bad b{color:var(--bad)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 16px}
.violations{border-color:var(--bad);background:var(--badbg)}.violations h2{color:var(--bad)}h2{font-size:15px;margin:0 0 8px}
.violations ul{margin:0;padding-left:20px}
.panel>summary{cursor:pointer;font-weight:600;font-size:15px}.dist{margin-top:10px;display:grid;grid-template-columns:minmax(120px,260px) 1fr 40px;gap:4px 10px;align-items:center}.dist .bar{height:10px;border-radius:5px;background:var(--accent)}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:0 0 10px}.controls label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:3px}
input,select,button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px}input{min-width:260px}
.count{margin-left:auto;color:var(--muted)}
.wrap{overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--card);max-height:70vh}
table{border-collapse:collapse;width:100%;min-width:1300px}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;word-break:break-word}
th{position:sticky;top:0;background:var(--card);cursor:pointer;white-space:nowrap;user-select:none;box-shadow:0 1px 0 var(--line)}
th[aria-sort=ascending]::after{content:" \\25B2";color:var(--accent)}th[aria-sort=descending]::after{content:" \\25BC";color:var(--accent)}
tr.viol td{background:var(--badbg)}a{color:var(--accent)}.badge{padding:1px 8px;border-radius:10px;font-size:12px}.imm{background:var(--immbg);color:var(--imm)}.trn{background:var(--trnbg);color:var(--trn)}
td.lf{white-space:nowrap}.lic{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.ic{fill:none;stroke:currentColor;stroke-width:1.5}.copy{display:inline-flex;vertical-align:middle;margin-left:6px;padding:3px 4px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--muted);cursor:pointer;line-height:0}
.copy:hover,.copy:focus-visible{color:var(--accent);border-color:var(--line)}.copy.done{color:var(--imm)}
.drawer{position:fixed;top:0;bottom:0;left:0;width:min(640px,92vw);display:flex;flex-direction:column;background:var(--card);border-right:1px solid var(--line);box-shadow:4px 0 24px rgba(0,0,0,.25);transform:translateX(-102%);visibility:hidden;transition:transform .2s ease,visibility .2s;z-index:10}
.drawer.open{transform:none;visibility:visible}
.drawer-head{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}.drawer-head .grow{flex:1;min-width:0}.drawer-head b,.drawer-head .sub{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drawer iframe{flex:1;width:100%;border:0;background:#fff}.x{font-size:18px;line-height:1;padding:2px 8px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (prefers-reduced-motion:reduce){.drawer{transition:none}}
footer{color:var(--muted);padding:8px 24px 24px;max-width:1500px;margin:0 auto;font-size:12px}
`;

// Sorts and filters the already-rendered rows; it never touches package data as markup.
const SCRIPT = `
(function(){
  var table=document.getElementById('pkgs'),body=table.tBodies[0],rows=[].slice.call(body.rows);
  var q=document.getElementById('q'),lic=document.getElementById('lic'),typ=document.getElementById('typ'),cnt=document.getElementById('count');
  function apply(){
    var t=q.value.toLowerCase(),shown=0;
    rows.forEach(function(r){
      var ok=(!t||r.textContent.toLowerCase().indexOf(t)>-1)&&(!lic.value||r.dataset.license===lic.value)&&(!typ.value||r.dataset.type===typ.value);
      r.hidden=!ok;if(ok)shown++;
    });
    cnt.textContent='Showing '+shown+' of '+rows.length+' packages';
  }
  [q,lic,typ].forEach(function(e){e.addEventListener('input',apply)});
  document.getElementById('reset').addEventListener('click',function(){q.value='';lic.value='';typ.value='';apply()});
  [].forEach.call(table.tHead.rows[0].cells,function(th,i){
    th.tabIndex=0;
    function sort(){
      var dir=th.getAttribute('aria-sort')==='ascending'?'descending':'ascending';
      [].forEach.call(th.parentNode.cells,function(c){c.removeAttribute('aria-sort')});
      th.setAttribute('aria-sort',dir);
      rows.sort(function(a,b){
        var x=a.cells[i].textContent,y=b.cells[i].textContent;
        var c=x.localeCompare(y,undefined,{numeric:true,sensitivity:'base'});
        return dir==='ascending'?c:-c;
      });
      rows.forEach(function(r){body.appendChild(r)});
    }
    th.addEventListener('click',sort);
    th.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();sort()}});
  });
  var drawer=document.getElementById('drawer'),frame=document.getElementById('d-frame'),dTitle=document.getElementById('d-title'),dFile=document.getElementById('d-file'),dOpen=document.getElementById('d-open'),dCopy=document.getElementById('d-copy'),dClose=document.getElementById('d-close'),live=document.getElementById('live'),lastLink=null;
  function openDrawer(a){
    lastLink=a;dTitle.textContent=a.dataset.pkg;dFile.textContent=a.title;
    dOpen.href=a.getAttribute('href');dCopy.dataset.path=a.title;
    frame.src=a.getAttribute('href');
    drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');dClose.focus();
  }
  function closeDrawer(){
    drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');frame.src='about:blank';
    if(lastLink)lastLink.focus();
  }
  function legacyCopy(text){
    return new Promise(function(resolve,reject){
      var t=document.createElement('textarea');t.value=text;t.setAttribute('readonly','');t.style.cssText='position:fixed;left:-9999px';
      document.body.appendChild(t);t.select();var ok=false;
      try{ok=document.execCommand('copy')}catch(e){}
      document.body.removeChild(t);ok?resolve():reject();
    });
  }
  function copyText(text){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text).catch(function(){return legacyCopy(text)});
    }
    return legacyCopy(text);
  }
  function flash(btn,message,done){
    btn.title=message;btn.classList.toggle('done',done);live.textContent=message;
    setTimeout(function(){btn.title='Copy complete path';btn.classList.remove('done');live.textContent=''},1500);
  }
  function copy(btn){copyText(btn.dataset.path).then(function(){flash(btn,'Copied!',true)},function(){flash(btn,'Copy failed',false)})}
  body.addEventListener('click',function(e){
    var a=e.target.closest('a.lic');
    if(a&&!(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button)){e.preventDefault();openDrawer(a);return}
    var b=e.target.closest('button.copy');if(b)copy(b);
  });
  dCopy.addEventListener('click',function(){copy(dCopy)});
  dClose.addEventListener('click',closeDrawer);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&drawer.classList.contains('open'))closeDrawer()});
  apply();
})();
`;

const packageManagerLine = (report: LicenseReport): string => {
  const pm = report.license.packageManager;
  return pm
    ? ` &middot; Package manager: <span title="${escapeHtml(describePackageManagerDetails(pm))}">${escapeHtml(describePackageManager(pm))}</span>`
    : '';
};

/** Renders a self-contained HTML page (no external requests) with the same fields as the JSON. */
export function renderHtmlReport(report: LicenseReport, meta: ReportMeta): string {
  const rows = reportRows(report, meta);
  const violations = meta.violations ?? [];
  const { total, direct, transitive, licenses } = summarize(report);
  const max = Math.max(1, ...licenses.map(([, n]) => n));

  const head = REPORT_FIELDS.map(
    (f) => `<th scope="col" title="Sort by ${escapeHtml(f)}">${escapeHtml(f)}</th>`,
  ).join('');
  const body = rows
    .map(({ entry, violation }) => {
      const tds = REPORT_FIELDS.map(
        (f) => `<td${f === 'license file' ? ' class="lf"' : ''}>${cell(f, entry)}</td>`,
      ).join('');
      return `<tr${violation ? ' class="viol"' : ''} data-license="${escapeHtml(licenseLabel(entry.licenses))}" data-type="${escapeHtml(entry.dependencyType)}">${tds}</tr>`;
    })
    .join('\n');

  const violationPanel = violations.length
    ? `<section class="panel violations" aria-label="License policy violations"><h2>License policy violated by ${violations.length} package(s)</h2><ul>${violations
        .map(
          (v) =>
            `<li><b>${escapeHtml(v.package)}</b> (${escapeHtml(v.licenses)}): ${ruleText[v.rule]}</li>`,
        )
        .join('')}</ul></section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(reportTitle(meta))}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${escapeHtml(reportTitle(meta))}</h1>
<p class="sub">Date: ${escapeHtml(reportDate(meta.generatedAt))}${packageManagerLine(report)}</p>
<div class="cards">
<div class="card"><b>${total}</b><span>packages</span></div>
<div class="card"><b>${direct}</b><span>direct</span></div>
<div class="card"><b>${transitive}</b><span>transitive</span></div>
<div class="card"><b>${licenses.length}</b><span>distinct licenses</span></div>
<div class="card${violations.length ? ' bad' : ''}"><b>${violations.length}</b><span>policy violations</span></div>
</div>
</header>
<main>
${violationPanel}
<details class="panel" open><summary>Licenses</summary><div class="dist">${licenses
    .map(
      ([name, n]) =>
        `<span>${escapeHtml(name)}</span><span class="bar" style="width:${Math.max(2, Math.round((n / max) * 100))}%"></span><span>${n}</span>`,
    )
    .join('')}</div></details>
<div class="controls">
<label>Search<input id="q" type="search" placeholder="name, license, publisher..."></label>
<label>License<select id="lic"><option value="">All</option>${licenses.map(([name]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}</select></label>
<label>Dependency type<select id="typ"><option value="">All</option><option value="direct">direct</option><option value="transitive">transitive</option></select></label>
<button id="reset" type="button">Reset</button>
<span id="count" class="count" aria-live="polite"></span>
</div>
<div class="wrap"><table id="pkgs"><caption class="sub" style="text-align:left;padding:6px 10px">Click a column header to sort</caption><thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody></table></div>
</main>
<footer>Generated by npm-license-tracker</footer>
${ICON_SPRITE}
<aside id="drawer" class="drawer" aria-hidden="true" aria-label="License file">
<div class="drawer-head">
<div class="grow"><b id="d-title"></b><span id="d-file" class="sub"></span></div>
<button type="button" id="d-copy" class="copy" data-path="" title="Copy complete path" aria-label="Copy complete path">${COPY_ICON}</button>
<a id="d-open" href="about:blank" target="_blank" rel="noopener noreferrer">Open in new tab</a>
<button type="button" id="d-close" class="copy x" aria-label="Close license file" title="Close (Esc)">&times;</button>
</div>
<iframe id="d-frame" title="License file" sandbox src="about:blank"></iframe>
</aside>
<span id="live" class="sr" aria-live="polite"></span>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
