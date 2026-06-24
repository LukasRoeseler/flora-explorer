/* FLoRA Explorer — main application logic
   Overview · Browse Studies · Years & Disciplines tabs */

// ----- Theme (light/dark) -----
(function() {
    const stored = localStorage.getItem('flora-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = stored || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
})();

function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'light'; }

document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('flora-theme', next);
    if (window._rerenderAllCharts) window._rerenderAllCharts();
});

// ----- Config -----
// Prefer local snapshot (daily-refreshed by GitHub Action); fall back to upstream live CSV.
const LOCAL_CSV_URL = 'data/flora.csv';
const REMOTE_CSV_URL = 'https://raw.githubusercontent.com/forrtproject/FReD-data/refs/heads/main/output/flora.csv';
const FLORA_META_URL = 'data/flora_meta.json';
const CITATIONS_META_URL = 'data/meta.json';
const IMPACT_META_URL = 'data/impact_factor_meta.json';
const IMPACT_DATA_URL = 'data/impact_factor_data.json';
const DISCIPLINES_URL = 'data/disciplines.json';
const CITATION_URL = 'https://raw.githubusercontent.com/forrtproject/FReD-data/refs/heads/main/CITATION.cff';
const FAQ_URL = 'https://raw.githubusercontent.com/forrtproject/fred-data/refs/heads/main/output/flora_faq.md';

const OUTCOME_COLORS = {
    successful:   '#2f8f4f',
    failed:       '#b3331e',
    mixed:        '#d49b1d',
    inconclusive: '#6f7686',
    other:        '#a0a7b4'
};

// Filled at runtime from data/disciplines.json
let DISCIPLINES = {};
let JOURNAL_TO_DISCIPLINE = {};

function disciplineForJournal(journalName) {
    if (!journalName) return 'Uncategorized';
    return JOURNAL_TO_DISCIPLINE[journalName.toLowerCase().trim()] || 'Uncategorized';
}

function themeAxisColors() {
    const dark = currentTheme() === 'dark';
    return {
        grid:   dark ? '#2d2e3d' : '#dfd8e5',
        tick:   dark ? '#b8b5c4' : '#4e4858',
        legend: dark ? '#e8e6ee' : '#2a2330'
    };
}

// ----- State -----
let fullRowData = [];
let dataTable = null;
let overviewChart = null;
let trendOrigYearChart = null;
let trendRepYearChart = null;
let trendJournalChart = null;
let trendRepJournalChart = null;
let trendFieldChart = null;
let trendsInitialized = false;

// ===== Utilities =====
function classifyOutcome(outcomeRaw) {
    if (!outcomeRaw) return 'other';
    const o = outcomeRaw.toLowerCase().trim();
    if (o.includes('success') || o === 'replicated' || (o.includes('robust') && !o.includes('challenge') && !o.includes('not'))) return 'successful';
    if (o.includes('fail') || o === 'not replicated' || o.includes('computational issue') || o.includes('robustness challenge')) return 'failed';
    if (o.includes('mixed') || o.includes('partial')) return 'mixed';
    if (o.includes('inconclusive')) return 'inconclusive';
    return 'other';
}

function hasMatchedOutcome(row) {
    const c = classifyOutcome(row.outcome);
    return c === 'successful' || c === 'failed' || c === 'mixed' || c === 'inconclusive';
}

function classifyKind(row) {
    const t = (row.type || '').toLowerCase();
    if (t.includes('reproduc')) return 'reproduction';
    if (t.includes('replic')) return 'replication';
    const o = (row.outcome || '').toLowerCase();
    if (o.includes('computational') || o.includes('robust')) return 'reproduction';
    if (o) return 'replication';
    return 'unknown';
}

function classifyReproductionSubkind(row) {
    const t = (row.type || '').toLowerCase();
    const o = (row.outcome || '').toLowerCase();
    const blob = `${t} ${o}`;
    if (blob.includes('robust')) return 'robustness';
    if (blob.includes('computational') || blob.includes('numerical')) return 'numerical';
    return 'unknown';
}

function filterByKind(data, kind) {
    if (!kind || kind === 'all') return data;
    if (kind === 'replication') return data.filter(r => classifyKind(r) === 'replication');
    if (kind === 'reproduction') return data.filter(r => classifyKind(r) === 'reproduction');
    if (kind === 'reproduction-numerical') {
        return data.filter(r => classifyKind(r) === 'reproduction' && classifyReproductionSubkind(r) === 'numerical');
    }
    if (kind === 'reproduction-robustness') {
        return data.filter(r => classifyKind(r) === 'reproduction' && classifyReproductionSubkind(r) === 'robustness');
    }
    return data;
}

function getOutcomeBadge(outcome) {
    if (!outcome) return '<span class="badge badge-unknown">Unknown</span>';
    const cls = classifyOutcome(outcome);
    const map = { successful: 'badge-successful', failed: 'badge-failed', mixed: 'badge-mixed', inconclusive: 'badge-inconclusive', other: 'badge-unknown' };
    return `<span class="badge ${map[cls]}">${escapeHtml(outcome)}</span>`;
}

function getOutcomeBadgeShort(outcome) {
    if (!outcome) return '<span class="badge badge-unknown">Unknown</span>';
    const o = outcome.toLowerCase().trim();
    const cls = classifyOutcome(outcome);
    const colorMap = { successful: 'badge-successful', failed: 'badge-failed', mixed: 'badge-mixed', inconclusive: 'badge-inconclusive', other: 'badge-unknown' };
    let short;
    const compState = o.includes('computationally successful') ? 'CS' :
                      o.includes('computational issue') ? 'CI' : null;
    const robState = o.includes('robustness challenge') ? 'RC' :
                     o.includes('robustness not checked') ? 'RNC' :
                     (o.includes('robust') && !o.includes('not') && !o.includes('challenge')) ? 'R' : null;
    if (compState && robState) short = `${compState} · ${robState}`;
    else if (compState) short = compState === 'CS' ? 'Comp. Successful' : 'Comp. Issues';
    else if (robState) short = robState === 'R' ? 'Robust' : robState === 'RC' ? 'Robustness Issues' : 'Robustness N/C';
    else if (cls === 'successful') short = 'Successful';
    else if (cls === 'failed') short = 'Failed';
    else if (cls === 'mixed') short = 'Mixed';
    else if (cls === 'inconclusive') short = 'Inconclusive';
    else short = outcome.length > 20 ? outcome.slice(0, 18) + '…' : outcome;
    return `<span class="badge ${colorMap[cls]}" title="${escapeHtml(outcome)}">${escapeHtml(short)}</span>`;
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function truncateText(text, maxLength = 60) {
    if (!text) return '-';
    return text.length > maxLength ? text.substring(0, maxLength) + '…' : text;
}

function formatDOI(doi, full = false) {
    if (!doi) return '-';
    const doiUrl = doi.startsWith('http') ? doi : `https://doi.org/${doi}`;
    const shortDoi = doi.replace('https://doi.org/', '').replace('http://doi.org/', '');
    if (full) return `<a href="${doiUrl}" target="_blank" class="doi-link">${escapeHtml(shortDoi)}</a>`;
    return `<a href="${doiUrl}" target="_blank" class="doi-link" title="${escapeHtml(shortDoi)}">${escapeHtml(shortDoi.substring(0, 25))}${shortDoi.length > 25 ? '…' : ''}</a>`;
}

function formatUrlOrDoi(url, doi) {
    if (url) {
        const displayUrl = url.length > 40 ? url.substring(0, 40) + '…' : url;
        return `<a href="${escapeHtml(url)}" target="_blank" class="doi-link">${escapeHtml(displayUrl)}</a>`;
    }
    if (doi) return formatDOI(doi, true);
    return '-';
}

function formatUrlOrDoiShort(url, doi) {
    if (url) {
        const displayUrl = url.length > 25 ? url.substring(0, 25) + '…' : url;
        return `<a href="${escapeHtml(url)}" target="_blank" class="doi-link" title="${escapeHtml(url)}">${escapeHtml(displayUrl)}</a>`;
    }
    if (doi) return formatDOI(doi, false);
    return '-';
}

function formatAuthors(authorData) {
    if (!authorData) return '-';
    try {
        const authors = JSON.parse(authorData);
        if (Array.isArray(authors)) {
            const names = authors.map(a => {
                if (typeof a === 'string') return a;
                if (a.family && a.given) return `${a.given} ${a.family}`;
                if (a.name) return a.name;
                if (a.family) return a.family;
                return JSON.stringify(a);
            });
            return escapeHtml(names.join(', '));
        }
        return escapeHtml(authorData);
    } catch (e) {
        return escapeHtml(authorData);
    }
}

function shortAuthors(authorData) {
    if (!authorData) return '';
    try {
        const authors = JSON.parse(authorData);
        if (Array.isArray(authors) && authors.length > 0) {
            const first = authors[0];
            const firstName = typeof first === 'string' ? first : (first.family || first.name || '');
            if (authors.length === 1) return firstName;
            if (authors.length === 2) {
                const second = authors[1];
                const secondName = typeof second === 'string' ? second : (second.family || second.name || '');
                return `${firstName} & ${secondName}`;
            }
            return `${firstName} et al.`;
        }
    } catch (e) {
        const short = authorData.split(/[,;]/)[0].trim();
        return short.length > 40 ? short.substring(0, 40) + '…' : short;
    }
    return '';
}

// ===== Overview =====
function updateOverviewStats(data) {
    const total = data.length;
    const eligible = data.filter(r => classifyKind(r) === 'replication' && hasMatchedOutcome(r));
    let successful = 0, failed = 0, mixed = 0;
    eligible.forEach(row => {
        const c = classifyOutcome(row.outcome);
        if (c === 'successful') successful++;
        else if (c === 'failed') failed++;
        else if (c === 'mixed') mixed++;
    });
    document.getElementById('ov-total').textContent = total.toLocaleString();
    document.getElementById('ov-successful').textContent = successful.toLocaleString();
    document.getElementById('ov-failed').textContent = failed.toLocaleString();
    document.getElementById('ov-mixed').textContent = mixed.toLocaleString();
}

function renderOverviewChart(data) {
    const eligible = data.filter(r => classifyKind(r) === 'replication' && hasMatchedOutcome(r));
    const counts = { successful: 0, mixed: 0, failed: 0, inconclusive: 0 };
    eligible.forEach(row => { counts[classifyOutcome(row.outcome)]++; });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const datasets = [
        { label: 'Successful',   data: [counts.successful],   backgroundColor: OUTCOME_COLORS.successful },
        { label: 'Mixed',        data: [counts.mixed],        backgroundColor: OUTCOME_COLORS.mixed },
        { label: 'Failed',       data: [counts.failed],       backgroundColor: OUTCOME_COLORS.failed },
        { label: 'Inconclusive', data: [counts.inconclusive], backgroundColor: OUTCOME_COLORS.inconclusive }
    ];
    const ctx = document.getElementById('overview-outcome-chart').getContext('2d');
    if (overviewChart) overviewChart.destroy();
    const ac = themeAxisColors();
    overviewChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: ['Replications'], datasets },
        options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: {
                legend: { position: 'bottom', labels: { color: ac.legend, boxWidth: 14, padding: 14, font: { size: 12 } } },
                tooltip: { callbacks: { label: ctx => {
                    const v = ctx.parsed.x; const pct = total ? ((v / total) * 100).toFixed(1) : 0;
                    return `${ctx.dataset.label}: ${v.toLocaleString()} (${pct}%)`;
                }}}
            },
            scales: {
                x: { stacked: true, min: 0, max: total, grid: { color: ac.grid }, ticks: { color: ac.tick } },
                y: { stacked: true, display: false }
            }
        }
    });
}

function studyLink(doi, url, innerHtml, extraClass = '') {
    let href = '';
    if (doi) href = doi.startsWith('http') ? doi : `https://doi.org/${doi}`;
    else if (url) href = url;
    if (href) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" class="ex-link ${extraClass}" title="Open ${escapeHtml(href)}">${innerHtml}</a>`;
    return `<span class="ex-link ex-link-disabled ${extraClass}">${innerHtml}</span>`;
}

function renderRandomExamples(data) {
    const container = document.getElementById('random-examples');
    const usable = data.filter(r => (r.title_o || r.author_o) && r.outcome);
    if (usable.length === 0) { container.innerHTML = '<p class="text-muted">No examples available.</p>'; return; }
    const shuffled = [...usable].sort(() => Math.random() - 0.5).slice(0, 4);
    container.innerHTML = shuffled.map(r => {
        const cls = classifyOutcome(r.outcome);
        const origTitle = r.title_o || `${shortAuthors(r.author_o)} (${r.year_o || 'n.d.'})`;
        const origMeta = [shortAuthors(r.author_o), r.year_o].filter(Boolean).join(' · ');
        const repTitle = r.title_r || `${shortAuthors(r.author_r)} (${r.year_r || 'n.d.'})`;
        const repMeta = [shortAuthors(r.author_r), r.year_r].filter(Boolean).join(' · ');
        const origInner = `
            <span class="ex-line-label">Original</span>
            <span class="ex-line-title">${escapeHtml(truncateText(origTitle, 110))}</span>
            ${origMeta ? `<span class="ex-line-meta">${escapeHtml(origMeta)}</span>` : ''}
        `;
        const repInner = `
            <span class="ex-line-label">Replication</span>
            <span class="ex-line-title">${escapeHtml(truncateText(repTitle, 110))}</span>
            ${repMeta ? `<span class="ex-line-meta">${escapeHtml(repMeta)}</span>` : ''}
        `;
        const hasRep = !!(r.title_r || r.author_r || r.doi_r || r.url_r);
        return `
            <div class="example-card outcome-${cls}">
                ${studyLink(r.doi_o, null, origInner)}
                ${hasRep ? studyLink(r.doi_r, r.url_r, repInner) : ''}
                <div class="ex-outcome">${getOutcomeBadge(r.outcome)}${r.type ? '<span class="badge bg-light text-dark">' + escapeHtml(r.type) + '</span>' : ''}</div>
            </div>
        `;
    }).join('');
}

document.getElementById('reshuffle-btn').addEventListener('click', () => {
    if (fullRowData.length) renderRandomExamples(fullRowData);
});

// ===== Citation (CFF) =====
async function loadCitation() {
    const box = document.getElementById('citation-text');
    try {
        const res = await fetch(CITATION_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        const cff = jsyaml.load(text);
        if (!cff || !Array.isArray(cff.authors)) throw new Error('Could not parse authors from CITATION.cff');

        const authors = cff.authors.map(a => {
            const family = a['family-names'] || a.family || '';
            const given = a['given-names'] || a.given || '';
            const nameOnly = a.name || '';
            if (family) {
                if (given) {
                    const initials = given.split(/[\s\-]+/).filter(Boolean)
                        .map(part => { const m = part.match(/\p{L}/u); return m ? m[0].toUpperCase() + '.' : ''; })
                        .filter(Boolean).join(' ');
                    return initials ? `${family}, ${initials}` : family;
                }
                return family;
            }
            return nameOnly;
        }).filter(Boolean);

        let authorsStr;
        if (authors.length === 0) authorsStr = '';
        else if (authors.length === 1) authorsStr = authors[0];
        else if (authors.length === 2) authorsStr = `${authors[0]}, & ${authors[1]}`;
        else if (authors.length <= 20) authorsStr = authors.slice(0, -1).join(', ') + ', & ' + authors[authors.length - 1];
        else authorsStr = authors.slice(0, 19).join(', ') + ', … ' + authors[authors.length - 1];

        const year = cff['date-released'] ? String(cff['date-released']).substring(0, 4) : '';
        const title = cff.title || '';
        const version = cff.version ? ` (Version ${cff.version})` : '';
        const doi = cff.doi || '';
        const doiLink = doi ? `<a href="https://doi.org/${doi}" target="_blank" class="doi-link">https://doi.org/${doi}</a>` : '';

        const htmlParts = [];
        if (authorsStr) htmlParts.push(escapeHtml(authorsStr));
        htmlParts.push(`(${escapeHtml(year)}).`);
        htmlParts.push(`<em>${escapeHtml(title)}</em>${escapeHtml(version)} [Dataset].`);
        if (doiLink) htmlParts.push(doiLink);
        box.innerHTML = htmlParts.join(' ');
        ['citation-text-top', 'citation-text-browse'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.innerHTML = htmlParts.join(' ');
        });

        const plainParts = [];
        if (authorsStr) plainParts.push(authorsStr);
        plainParts.push(`(${year}).`);
        plainParts.push(`${title}${version} [Dataset].`);
        if (doi) plainParts.push(`https://doi.org/${doi}`);
        box.dataset.plain = plainParts.join(' ');
    } catch (err) {
        console.error('Citation load failed:', err);
        const errHtml = '<span style="color: var(--flora-muted);">Could not load live citation. Please see the <a href="' + CITATION_URL + '" target="_blank" class="doi-link">CITATION.cff file</a>.</span>';
        box.innerHTML = errHtml;
        ['citation-text-top', 'citation-text-browse'].forEach(function(id) {
            var el = document.getElementById(id); if (el) el.innerHTML = errHtml;
        });
    }
}

document.getElementById('citation-copy-btn').addEventListener('click', () => {
    const box = document.getElementById('citation-text');
    const text = box.dataset.plain || box.textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('citation-copy-btn');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
    });
});

document.getElementById('website-citation-copy-btn').addEventListener('click', () => {
    const text = 'Wallrich, L., & Röseler, L. (2026). FLoRA Explorer [Website]. https://forrt.org/flora-explorer/';
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('website-citation-copy-btn');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
    });
});

// ===== FAQ =====
function renderInlineMd(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s;
}

function renderFaqAnswer(lines) {
    const out = []; let i = 0;
    while (i < lines.length) {
        const ln = lines[i];
        if (/^\s*[-*]\s+/.test(ln)) {
            const items = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
            out.push('<ul>' + items.map(it => `<li>${renderInlineMd(it)}</li>`).join('') + '</ul>');
            continue;
        }
        if (/^\s*\d+\.\s+/.test(ln)) {
            const items = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
            out.push('<ol>' + items.map(it => `<li>${renderInlineMd(it)}</li>`).join('') + '</ol>');
            continue;
        }
        if (ln.trim() === '') { i++; continue; }
        const para = [];
        while (i < lines.length && lines[i].trim() !== '' && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) { para.push(lines[i]); i++; }
        out.push('<p>' + renderInlineMd(para.join(' ')) + '</p>');
    }
    return out.join('');
}

function parseFaqMarkdown(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const items = []; let currentQA = null; let currentSection = null;
    const flushQA = () => { if (currentQA) { items.push(currentQA); currentQA = null; } };
    const flushSection = () => { if (currentSection) { items.push(currentSection); currentSection = null; } };
    for (const ln of lines) {
        const h1 = /^#\s+(.+)$/.exec(ln);
        const h2 = /^##\s+(.+)$/.exec(ln);
        const h3 = /^#{3,4}\s+(.+)$/.exec(ln);
        if (h2 || h1) { flushQA(); flushSection(); currentSection = { type: 'section', text: (h2 || h1)[1].trim(), body: [] }; continue; }
        if (h3) { flushQA(); flushSection(); currentQA = { type: 'qa', question: h3[1].trim(), body: [] }; continue; }
        if (currentQA) currentQA.body.push(ln);
        else if (currentSection) currentSection.body.push(ln);
    }
    flushQA(); flushSection();
    return items;
}

async function loadFaqs() {
    const loadingEl = document.getElementById('faq-loading');
    const contentEl = document.getElementById('faq-content');
    const errorEl = document.getElementById('faq-error');
    try {
        const res = await fetch(FAQ_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const md = await res.text();
        const items = parseFaqMarkdown(md);
        if (items.length === 0) throw new Error('No FAQ items found');

        contentEl.innerHTML = items.map(it => {
            if (it.type === 'section') {
                const intro = (it.body && it.body.some(l => l.trim())) ? `<div class="faq-section-intro">${renderFaqAnswer(it.body)}</div>` : '';
                return `<div class="faq-section"><h4 class="faq-section-title">${escapeHtml(it.text)}</h4>${intro}</div>`;
            }
            return `
                <div class="faq-item">
                    <button type="button" class="faq-question" aria-expanded="false">
                        <svg class="faq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
                        <span>${escapeHtml(it.question)}</span>
                    </button>
                    <div class="faq-answer">${renderFaqAnswer(it.body)}</div>
                </div>`;
        }).join('');
        contentEl.querySelectorAll('.faq-question').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.faq-item');
                const open = item.classList.toggle('open');
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
        });
        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';
    } catch (err) {
        console.error('FAQ load failed:', err);
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
    }
}

// ===== Browse: detail row =====
function formatDetailRow(rowData) {
    return `
        <div class="detail-row">
            <div class="detail-grid">
                <div class="detail-card">
                    <h6>Original Study</h6>
                    <div class="detail-section">
                        <div><span class="detail-label">Title:</span> <span class="detail-value">${escapeHtml(rowData.title_o) || '-'}</span></div>
                        <div><span class="detail-label">Authors:</span> <span class="detail-value">${formatAuthors(rowData.author_o)}</span></div>
                        <div><span class="detail-label">Year:</span> <span class="detail-value">${escapeHtml(rowData.year_o) || '-'}</span></div>
                        <div><span class="detail-label">DOI:</span> <span class="detail-value">${formatDOI(rowData.doi_o, true)}</span></div>
                        ${rowData.journal_o ? `<div><span class="detail-label">Journal:</span> <span class="detail-value">${escapeHtml(rowData.journal_o)}</span></div>` : ''}
                    </div>
                </div>
                <div class="detail-card">
                    <h6>Replication Study</h6>
                    <div class="detail-section">
                        <div><span class="detail-label">Title:</span> <span class="detail-value">${escapeHtml(rowData.title_r) || '-'}</span></div>
                        <div><span class="detail-label">Authors:</span> <span class="detail-value">${formatAuthors(rowData.author_r)}</span></div>
                        <div><span class="detail-label">Year:</span> <span class="detail-value">${escapeHtml(rowData.year_r) || '-'}</span></div>
                        <div><span class="detail-label">Report:</span> <span class="detail-value">${formatUrlOrDoi(rowData.url_r, rowData.doi_r)}</span></div>
                        ${rowData.journal_r ? `<div><span class="detail-label">Journal:</span> <span class="detail-value">${escapeHtml(rowData.journal_r)}</span></div>` : ''}
                    </div>
                </div>
            </div>
            <div class="detail-card mt-3">
                <h6>Replication Details</h6>
                <div class="detail-section">
                    <div><span class="detail-label">Outcome:</span> <span class="detail-value">${getOutcomeBadge(rowData.outcome)}</span></div>
                    ${rowData.outcome_quote ? `<div><span class="detail-label">Outcome Quote:</span> <span class="detail-value" style="font-style: italic;">"${escapeHtml(rowData.outcome_quote)}"</span></div>` : ''}
                    <div><span class="detail-label">Type:</span> <span class="detail-value">${escapeHtml(rowData.type) || '-'}</span></div>
                    ${rowData.effect_o ? `<div><span class="detail-label">Original Effect:</span> <span class="detail-value">${escapeHtml(rowData.effect_o)}</span></div>` : ''}
                    ${rowData.effect_r ? `<div><span class="detail-label">Replication Effect:</span> <span class="detail-value">${escapeHtml(rowData.effect_r)}</span></div>` : ''}
                    ${rowData.n_o ? `<div><span class="detail-label">Original N:</span> <span class="detail-value">${escapeHtml(rowData.n_o)}</span></div>` : ''}
                    ${rowData.n_r ? `<div><span class="detail-label">Replication N:</span> <span class="detail-value">${escapeHtml(rowData.n_r)}</span></div>` : ''}
                    ${rowData.description ? `<div><span class="detail-label">Description:</span> <span class="detail-value">${escapeHtml(rowData.description)}</span></div>` : ''}
                </div>
            </div>
        </div>`;
}

function initDataTable(data) {
    const tableData = data.map(row => [
        null,
        { display: truncateText(row.title_o || row.author_o, 50), search: `${row.title_o || ''} ${row.author_o || ''} ${row.journal_o || ''}` },
        row.year_o || '-',
        { display: truncateText(row.title_r || row.author_r, 50), search: `${row.title_r || ''} ${row.author_r || ''} ${row.journal_r || ''}` },
        row.year_r || '-',
        { display: getOutcomeBadgeShort(row.outcome), search: `${row.outcome || ''} ${row.outcome_quote || ''}` },
        truncateText(row.type, 15) || '-',
        { display: formatDOI(row.doi_o), search: row.doi_o || '' },
        { display: formatUrlOrDoiShort(row.url_r, row.doi_r), search: `${row.url_r || ''} ${row.doi_r || ''}` }
    ]);

    dataTable = $('#flora-table').DataTable({
        data: tableData, responsive: false, pageLength: 25,
        lengthMenu: [[10, 25, 50, 100, -1], [10, 25, 50, 100, "All"]],
        order: [[4, 'desc']],
        language: { search: "Search:", searchPlaceholder: "Filter studies (searches full references)..." },
        columnDefs: [
            { targets: 0, className: 'details-control', orderable: false, data: null, defaultContent: '', width: '30px' },
            { targets: [1, 3], width: '20%', render: (d, t) => t === 'display' ? (typeof d === 'object' ? d.display : d) : (typeof d === 'object' ? d.search : d) },
            { targets: [2, 4], width: '5%' },
            { targets: 5, width: '9%', render: (d, t) => t === 'display' ? (typeof d === 'object' ? d.display : d) : (typeof d === 'object' ? d.search : d) },
            { targets: 6, width: '6%' },
            { targets: [7, 8], width: '12%', render: (d, t) => t === 'display' ? (typeof d === 'object' ? d.display : d) : (typeof d === 'object' ? d.search : d) }
        ],
        createdRow: (row, d, dataIndex) => { $(row).attr('data-index', dataIndex); }
    });

    dataTable.on('search.dt', renderBrowseOutcomeChart);

    $('#flora-table tbody').on('click', 'td.details-control', function() {
        const tr = $(this).closest('tr');
        const row = dataTable.row(tr);
        const dataIndex = tr.attr('data-index');
        if (row.child.isShown()) { row.child.hide(); tr.removeClass('shown'); }
        else { row.child(formatDetailRow(fullRowData[dataIndex])).show(); tr.addClass('shown'); }
    });
}

// ===== Browse mobile =====
const BM_PAGE_SIZE = 20;
let bmFiltered = []; let bmPage = 0; let bmInitialized = false;

function bmSearchableText(row) {
    return [row.title_o, row.author_o, row.journal_o, row.year_o, row.doi_o,
            row.title_r, row.author_r, row.journal_r, row.year_r, row.doi_r, row.url_r,
            row.outcome, row.outcome_quote, row.type, row.description].filter(Boolean).join(' | ').toLowerCase();
}
function bmHref(doi, url) { if (doi) return doi.startsWith('http') ? doi : `https://doi.org/${doi}`; if (url) return url; return ''; }
function bmAuthorYear(authorData, year) { const a = shortAuthors(authorData); const y = year ? `(${year})` : ''; return [a, y].filter(Boolean).join(' '); }
function bmRenderTitleLine(title, fallback, doi, url) {
    const text = escapeHtml(title || fallback || '—');
    const href = bmHref(doi, url);
    if (href) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text}</a>`;
    return text;
}
function bmCardHtml(row) {
    const oTitle = bmRenderTitleLine(row.title_o, shortAuthors(row.author_o), row.doi_o, null);
    const oMeta = [bmAuthorYear(row.author_o, row.year_o), row.journal_o].filter(Boolean).map(escapeHtml).join(' · ');
    const rTitle = bmRenderTitleLine(row.title_r, shortAuthors(row.author_r), row.doi_r, row.url_r);
    const rMeta = [bmAuthorYear(row.author_r, row.year_r), row.journal_r].filter(Boolean).map(escapeHtml).join(' · ');
    const tagsParts = [getOutcomeBadge(row.outcome)];
    if (row.type) tagsParts.push(`<span class="bm-tag-type">${escapeHtml(row.type)}</span>`);
    return `
        <div class="bm-card">
            <div class="bm-row"><div class="bm-row-label">Original</div><div class="bm-row-title">${oTitle}</div>${oMeta ? `<div class="bm-row-meta">${oMeta}</div>` : ''}</div>
            <div class="bm-divider"></div>
            <div class="bm-row"><div class="bm-row-label">Replication</div><div class="bm-row-title">${rTitle}</div>${rMeta ? `<div class="bm-row-meta">${rMeta}</div>` : ''}</div>
            <div class="bm-tags">${tagsParts.join('')}</div>
        </div>`;
}
function bmApplySearch(query) {
    const q = (query || '').trim().toLowerCase();
    const source = bmDataSource();
    bmFiltered = q ? source.filter(r => bmSearchableText(r).includes(q)) : source.slice();
    bmFiltered.sort((a, b) => (parseInt(b.year_r, 10) || 0) - (parseInt(a.year_r, 10) || 0));
    bmPage = 0; bmRender();
}
function bmRender() {
    const list = document.getElementById('browse-mobile-list');
    const meta = document.getElementById('browse-mobile-meta');
    const info = document.getElementById('bm-page-info');
    const prev = document.getElementById('bm-prev');
    const next = document.getElementById('bm-next');
    const pager = document.getElementById('browse-mobile-pager');
    if (!list) return;
    const total = bmFiltered.length;
    if (total === 0) {
        list.innerHTML = '<div class="bm-empty">No studies match your search.</div>';
        meta.textContent = '0 studies'; pager.style.display = 'none'; return;
    }
    const totalPages = Math.max(1, Math.ceil(total / BM_PAGE_SIZE));
    if (bmPage >= totalPages) bmPage = totalPages - 1;
    const start = bmPage * BM_PAGE_SIZE; const end = Math.min(total, start + BM_PAGE_SIZE);
    list.innerHTML = bmFiltered.slice(start, end).map(bmCardHtml).join('');
    meta.innerHTML = `Showing <strong>${start + 1}–${end}</strong> of <strong>${total.toLocaleString()}</strong> studies`;
    info.textContent = `Page ${bmPage + 1} of ${totalPages}`;
    prev.disabled = bmPage === 0; next.disabled = bmPage >= totalPages - 1;
    pager.style.display = totalPages > 1 ? 'flex' : 'none';
}
function setupBrowseMobile(data) {
    if (bmInitialized) return;
    bmInitialized = true;
    const input = document.getElementById('browse-mobile-input');
    const prev = document.getElementById('bm-prev');
    const next = document.getElementById('bm-next');
    let debounceTimer;
    input.addEventListener('input', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(() => bmApplySearch(input.value), 150); });
    prev.addEventListener('click', () => { if (bmPage > 0) { bmPage--; bmRender(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
    next.addEventListener('click', () => { bmPage++; bmRender(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    bmApplySearch('');
}

// ===== Browse kind filter =====
let browseKind = 'all';
let browseOutcomeChart = null;

function browseFilteredData() { return filterByKind(fullRowData, browseKind); }
function bmDataSource() { return browseFilteredData(); }

// Returns rows that pass both the kind filter AND the current DataTables search.
function getChartData() {
    if (dataTable) {
        const indices = dataTable.rows({ search: 'applied' }).indexes().toArray();
        return filterByKind(indices.map(i => fullRowData[i]), browseKind);
    }
    return browseFilteredData();
}

function renderBrowseOutcomeChart() {
    const data = getChartData();
    const eligible = data.filter(r => classifyKind(r) === 'replication' && hasMatchedOutcome(r));
    const counts = { successful: 0, mixed: 0, failed: 0, inconclusive: 0 };
    eligible.forEach(row => { counts[classifyOutcome(row.outcome)]++; });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const datasets = [
        { label: 'Successful',   data: [counts.successful],   backgroundColor: OUTCOME_COLORS.successful },
        { label: 'Mixed',        data: [counts.mixed],        backgroundColor: OUTCOME_COLORS.mixed },
        { label: 'Failed',       data: [counts.failed],       backgroundColor: OUTCOME_COLORS.failed },
        { label: 'Inconclusive', data: [counts.inconclusive], backgroundColor: OUTCOME_COLORS.inconclusive }
    ];
    const canvas = document.getElementById('browse-outcome-chart'); if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (browseOutcomeChart) browseOutcomeChart.destroy();
    const ac = themeAxisColors();
    browseOutcomeChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: ['Replications'], datasets },
        options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: {
                legend: { position: 'bottom', labels: { color: ac.legend, boxWidth: 14, padding: 14, font: { size: 12 } } },
                tooltip: { callbacks: { label: ctx => {
                    const v = ctx.parsed.x; const pct = total ? ((v / total) * 100).toFixed(1) : 0;
                    return `${ctx.dataset.label}: ${v.toLocaleString()} (${pct}%)`;
                }}}
            },
            scales: {
                x: { stacked: true, min: 0, max: Math.max(total, 1), grid: { color: ac.grid }, ticks: { color: ac.tick } },
                y: { stacked: true, display: false }
            }
        }
    });
}

function updateBrowseKindCount() {
    const el = document.getElementById('browse-kind-count'); if (!el) return;
    const n = browseFilteredData().length; const total = fullRowData.length;
    el.textContent = browseKind === 'all' ? `${n.toLocaleString()} studies` : `${n.toLocaleString()} of ${total.toLocaleString()} studies`;
}

function applyBrowseKind() {
    updateBrowseKindCount(); renderBrowseOutcomeChart();
    if (dataTable) dataTable.draw();
    if (bmInitialized) {
        const input = document.getElementById('browse-mobile-input');
        bmApplySearch(input ? input.value : '');
    }
}

function setupBrowseKindFilter() {
    document.querySelectorAll('.browse-kind-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.browse-kind-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browseKind = btn.dataset.kind || 'all';
            applyBrowseKind();
        });
    });
    $.fn.dataTable.ext.search.push(function(settings, searchData, dataIndex) {
        if (settings.nTable.id !== 'flora-table') return true;
        if (browseKind === 'all') return true;
        const row = fullRowData[dataIndex]; if (!row) return true;
        return classifyKind(row) === browseKind;
    });
    applyBrowseKind();
}

// ===== Trends =====
let trendsKind = 'all';
function trendsFilteredData() { return filterByKind(fullRowData, trendsKind); }
function updateTrendsCount() {
    const el = document.getElementById('trend-filter-count'); if (!el) return;
    const n = trendsFilteredData().length; const total = fullRowData.length;
    el.textContent = trendsKind === 'all' ? `${n.toLocaleString()} studies` : `${n.toLocaleString()} of ${total.toLocaleString()} studies`;
}

function trendsOutcomeLabel(row) {
    if (trendsKind === 'all') return '__all__';
    if (trendsKind === 'replication') {
        if (!hasMatchedOutcome(row)) return null;
        const c = classifyOutcome(row.outcome);
        if (c === 'successful') return 'Successful';
        if (c === 'mixed') return 'Mixed';
        if (c === 'failed') return 'Failed';
        if (c === 'inconclusive') return 'Inconclusive';
        return null;
    }
    const raw = (row.outcome || '').trim(); return raw || null;
}

function aggregateGeneric(data, keyFn) {
    const groups = new Map();
    data.forEach(row => {
        const k = keyFn(row);
        if (k === null || k === undefined || k === '') return;
        const label = trendsOutcomeLabel(row);
        if (label === null) return;
        if (!groups.has(k)) groups.set(k, { key: k, total: 0, byLabel: {} });
        const g = groups.get(k); g.total++; g.byLabel[label] = (g.byLabel[label] || 0) + 1;
    });
    return Array.from(groups.values());
}

function aggregateByYear(data, yearField) {
    const yearKey = row => {
        const yRaw = row[yearField]; if (!yRaw) return null;
        const match = String(yRaw).match(/\d{4}/); if (!match) return null;
        const y = parseInt(match[0], 10);
        if (!y || y < 1800 || y > 2100) return null;
        return String(y);
    };
    const out = aggregateGeneric(data, yearKey);
    out.sort((a, b) => parseInt(a.key, 10) - parseInt(b.key, 10));
    return out;
}

function aggregateByJournal(data, field, topN) {
    const out = aggregateGeneric(data, row => (row[field] || '').trim() || null);
    out.sort((a, b) => b.total - a.total);
    return out.slice(0, topN);
}

function aggregateByField(data) {
    const out = aggregateGeneric(data, row => disciplineForJournal(row.journal_o));
    const mapped = out.filter(e => e.key !== 'Uncategorized').sort((a, b) => b.total - a.total);
    const uncat = out.filter(e => e.key === 'Uncategorized');
    return [...mapped, ...uncat];
}

function trendsDatasets(agg) {
    if (trendsKind === 'all') return [{ label: 'Studies', data: agg.map(r => r.byLabel['__all__'] || 0), backgroundColor: '#8b1a4a' }];
    if (trendsKind === 'replication') {
        const order = ['Successful', 'Mixed', 'Failed', 'Inconclusive'];
        const colors = { 'Successful': OUTCOME_COLORS.successful, 'Mixed': OUTCOME_COLORS.mixed, 'Failed': OUTCOME_COLORS.failed, 'Inconclusive': OUTCOME_COLORS.inconclusive };
        return order.map(label => ({ label, data: agg.map(r => r.byLabel[label] || 0), backgroundColor: colors[label] }));
    }
    const labelSet = new Set();
    agg.forEach(r => Object.keys(r.byLabel).forEach(l => labelSet.add(l)));
    const labels = Array.from(labelSet).sort();
    const palette = ['#2f8f4f', '#38b2ac', '#4299e1', '#d49b1d', '#b3331e', '#9f7aea', '#6f7686', '#a0a7b4'];
    return labels.map((label, i) => ({ label, data: agg.map(r => r.byLabel[label] || 0), backgroundColor: palette[i % palette.length] }));
}

function wrapLabel(str, maxChars = 36) {
    if (!str) return '';
    if (str.length <= maxChars) return str;
    const words = String(str).split(/\s+/);
    const lines = []; let line = '';
    for (const w of words) {
        if (!line) { line = w; continue; }
        if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
        else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    if (lines.length > 3) {
        const trimmed = lines.slice(0, 3); const last = trimmed[2];
        trimmed[2] = (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last) + '…';
        return trimmed;
    }
    return lines;
}

function renderStackedChart(canvasId, agg, orientation, existing, opts = {}) {
    if (existing) existing.destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    const isHorizontal = orientation === 'horizontal';
    const ac = themeAxisColors();
    const wrapLabels = !!opts.wrapLabels;
    const labels = agg.map(r => wrapLabels ? wrapLabel(r.key, 38) : r.key);
    const datasets = trendsDatasets(agg);
    const isStacked = trendsKind !== 'all';
    const showLegend = trendsKind !== 'all';

    return new Chart(ctx, {
        type: 'bar', data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false, indexAxis: isHorizontal ? 'y' : 'x',
            plugins: {
                legend: showLegend ? { position: 'bottom', labels: { padding: 10, color: ac.legend, boxWidth: 12, font: { size: 11 } } } : { display: false },
                tooltip: { callbacks: {
                    title: items => { const label = items[0].label; return Array.isArray(label) ? label.join(' ') : label; },
                    afterLabel: ctx => {
                        if (trendsKind === 'all') return '';
                        const row = agg[ctx.dataIndex];
                        const val = ctx.parsed[isHorizontal ? 'x' : 'y'];
                        const pct = row.total ? ((val / row.total) * 100).toFixed(1) : 0;
                        return `(${pct}% of ${row.total})`;
                    }
                }}
            },
            scales: {
                x: { stacked: isStacked, grid: { color: ac.grid }, ticks: { color: ac.tick, autoSkip: !isHorizontal } },
                y: { stacked: isStacked, grid: { color: ac.grid, display: !isHorizontal }, ticks: { color: ac.tick, autoSkip: false, font: { size: isHorizontal ? 11 : 12 } } }
            },
            layout: isHorizontal ? { padding: { left: 6 } } : {}
        }
    });
}

function renderTrendOrigYear() { trendOrigYearChart = renderStackedChart('trend-orig-year', aggregateByYear(trendsFilteredData(), 'year_o'), 'vertical', trendOrigYearChart); }
function renderTrendRepYear() { trendRepYearChart = renderStackedChart('trend-rep-year', aggregateByYear(trendsFilteredData(), 'year_r'), 'vertical', trendRepYearChart); }
function renderTrendJournal() {
    const topN = parseInt(document.getElementById('journal-top-n').value, 10) || 15;
    const agg = aggregateByJournal(trendsFilteredData(), 'journal_o', topN);
    document.getElementById('trend-journal-container').style.height = Math.max(400, agg.length * 36) + 'px';
    trendJournalChart = renderStackedChart('trend-journal', agg, 'horizontal', trendJournalChart, { wrapLabels: true });
}
function renderTrendRepJournal() {
    const topN = parseInt(document.getElementById('rep-journal-top-n').value, 10) || 15;
    const agg = aggregateByJournal(trendsFilteredData(), 'journal_r', topN);
    document.getElementById('trend-rep-journal-container').style.height = Math.max(400, agg.length * 36) + 'px';
    trendRepJournalChart = renderStackedChart('trend-rep-journal', agg, 'horizontal', trendRepJournalChart, { wrapLabels: true });
}
function renderTrendField() {
    const agg = aggregateByField(trendsFilteredData());
    document.getElementById('trend-field-container').style.height = Math.max(360, agg.length * 44) + 'px';
    trendFieldChart = renderStackedChart('trend-field', agg, 'horizontal', trendFieldChart, { wrapLabels: true });
}
function renderAllTrends() {
    updateTrendsCount();
    renderTrendOrigYear(); renderTrendRepYear();
    renderTrendJournal(); renderTrendRepJournal();
    renderTrendField();
}

document.getElementById('journal-top-n').addEventListener('change', renderTrendJournal);
document.getElementById('rep-journal-top-n').addEventListener('change', renderTrendRepJournal);
document.querySelectorAll('#trends .trend-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#trends .trend-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        trendsKind = btn.dataset.kind || 'all';
        if (trendsInitialized && fullRowData.length) renderAllTrends();
    });
});

document.getElementById('trends-tab').addEventListener('shown.bs.tab', () => {
    if (!trendsInitialized && fullRowData.length) { trendsInitialized = true; renderAllTrends(); }
});

window._rerenderAllCharts = function() {
    if (fullRowData.length) {
        renderOverviewChart(fullRowData);
        if (trendsInitialized) renderAllTrends();
    }
    renderBrowseOutcomeChart();
    if (window._mcData) renderMcCharts(window._mcData);
    if (window._aoData) renderOverlapCharts(window._aoData);
};

// ===== Mean Citedness tab =====
window._mcData = null;

function mcPlotlyTheme() {
    const dark = currentTheme() === 'dark';
    return {
        paper: dark ? '#1d1e29' : '#ffffff',
        plot:  dark ? '#1d1e29' : '#ffffff',
        grid:  dark ? '#2d2e3d' : '#eeeaef',
        font:  dark ? '#e8e6ee' : '#2a2330',
    };
}

function renderMcCharts(d) {
    if (!d) return;
    window._mcData = d;
    const t = mcPlotlyTheme();
    const primary = getComputedStyle(document.documentElement)
        .getPropertyValue('--flora-primary').trim() || '#8b1a4a';

    // ── Overview grid ─────────────────────────────────────────────────────
    const ov = d.overview;
    const pctS = ov.n_total ? Math.round(100 * ov.n_success / ov.n_total) : 0;
    const pctF = ov.n_total ? Math.round(100 * ov.n_failed  / ov.n_total) : 0;
    document.getElementById('mc-overview').innerHTML = `
        <div class="mc-stat"><span class="mc-stat-value">${ov.n_total.toLocaleString()}</span><span class="mc-stat-label">Studies with OMC</span></div>
        <div class="mc-stat"><span class="mc-stat-value" style="color:#2f8f4f">${ov.n_success.toLocaleString()}</span><span class="mc-stat-label">Successful (${pctS}%)</span></div>
        <div class="mc-stat"><span class="mc-stat-value" style="color:#b3331e">${ov.n_failed.toLocaleString()}</span><span class="mc-stat-label">Failed (${pctF}%)</span></div>
        <div class="mc-stat"><span class="mc-stat-value" style="color:#d49b1d">${ov.n_mixed.toLocaleString()}</span><span class="mc-stat-label">Mixed</span></div>
        <div class="mc-stat"><span class="mc-stat-value">${ov.n_journals.toLocaleString()}</span><span class="mc-stat-label">Journals matched</span></div>
        <div class="mc-stat"><span class="mc-stat-value">${ov.n_disciplines}</span><span class="mc-stat-label">Disciplines</span></div>`;

    // ── Distribution chart (Plotly stacked bar) ───────────────────────────
    const bins  = d.histogram || [];
    const xMids = bins.map(b => +((b.bin_lo + b.bin_hi) / 2).toFixed(2));
    const hTpl  = 'OMC %{x:.2f}<br>%{y} studies<extra>%{fullData.name}</extra>';
    Plotly.newPlot('mc-dist-chart', [
        { x: xMids, y: bins.map(b => b.successful),   name: 'Successful',   type: 'bar', marker: { color: OUTCOME_COLORS.successful },   hovertemplate: hTpl },
        { x: xMids, y: bins.map(b => b.failed),       name: 'Failed',       type: 'bar', marker: { color: OUTCOME_COLORS.failed },       hovertemplate: hTpl },
        { x: xMids, y: bins.map(b => b.mixed),        name: 'Mixed',        type: 'bar', marker: { color: OUTCOME_COLORS.mixed },        hovertemplate: hTpl },
        { x: xMids, y: bins.map(b => b.inconclusive), name: 'Inconclusive', type: 'bar', marker: { color: OUTCOME_COLORS.inconclusive }, hovertemplate: hTpl },
    ], {
        barmode: 'stack', bargap: 0.05,
        margin: { t: 10, r: 10, b: 50, l: 55 },
        xaxis: { title: 'OpenAlex Mean Citedness (OMC)', gridcolor: t.grid, color: t.font, tickfont: { color: t.font } },
        yaxis: { title: 'Number of studies',             gridcolor: t.grid, color: t.font, tickfont: { color: t.font } },
        plot_bgcolor: t.plot, paper_bgcolor: t.paper,
        font: { family: 'Inter, sans-serif', size: 12, color: t.font },
        legend: { orientation: 'h', y: -0.2, font: { color: t.font } },
        height: 320,
    }, { displayModeBar: false, responsive: true });

    const st = d.stats || {};
    const gc = Array.isArray(d.gam_curve) ? d.gam_curve : [];
    const isDark = currentTheme() === 'dark';
    const lineColor = isDark ? '#e0a5c0' : primary;

    // ── GAM chart (Plotly) ────────────────────────────────────────────────
    const gamDiv = document.getElementById('mc-gam-chart');
    const hasGam = gc.length > 0 && st && st.n_model >= 30;
    if (!hasGam) {
        gamDiv.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:180px;color:var(--flora-muted);font-size:0.9rem;text-align:center;padding:2rem">Not enough data to fit a smooth model<br>(requires ≥30 studies with successful or failed outcomes that have OMC data)</div>';
        return;
    }
    const jitter2 = (Array.isArray(d.jitter) ? d.jitter : []).map(pt => ({
        x: pt.omc + (Math.random() - 0.5) * 0.15,
        y: pt.outcome + (Math.random() - 0.5) * 0.06,
        lbl: pt.outcome === 1 ? 'Successful' : 'Failed',
    }));
    const gamTraces = [
        { x: gc.map(p => p.omc), y: gc.map(p => p.p_lo), type: 'scatter', mode: 'lines',
          line: { width: 0 }, showlegend: false, hoverinfo: 'skip', name: '_lo' },
        { x: gc.map(p => p.omc), y: gc.map(p => p.p_hi), type: 'scatter', mode: 'lines',
          fill: 'tonexty', fillcolor: isDark ? 'rgba(224,165,192,0.18)' : 'rgba(139,26,74,0.12)',
          line: { width: 0 }, showlegend: false, hoverinfo: 'skip', name: '_hi' },
        { x: gc.map(p => p.omc), y: gc.map(p => p.p), type: 'scatter', mode: 'lines',
          line: { color: lineColor, width: 2.5 }, name: 'Smooth fit',
          hovertemplate: 'OMC = %{x:.2f}<br>P(success) = %{y:.1%}<extra>Smooth fit</extra>' },
        { x: jitter2.map(p => p.x), y: jitter2.map(p => p.y), type: 'scatter', mode: 'markers',
          marker: { color: isDark ? 'rgba(210,210,220,0.20)' : 'rgba(80,80,80,0.15)', size: 5, line: { width: 0 } },
          name: 'Studies', text: jitter2.map(p => p.lbl),
          hovertemplate: 'OMC = %{x:.2f}<br>%{text}<extra></extra>' },
    ];
    const gamLayout = {
        height: 640,
        margin: { t: 10, r: 10, b: 50, l: 60 },
        xaxis: { title: 'OpenAlex Mean Citedness (OMC)', gridcolor: t.grid, color: t.font, tickfont: { color: t.font } },
        yaxis: { title: 'P(successful replication)', range: [-0.08, 1.08],
                 tickformat: '.0%', gridcolor: t.grid, color: t.font, tickfont: { color: t.font } },
        plot_bgcolor: t.plot, paper_bgcolor: t.paper,
        font: { family: 'Inter, sans-serif', size: 12, color: t.font },
        legend: { orientation: 'h', y: -0.2, font: { color: t.font } },
        shapes: [{
            type: 'line', xref: 'paper', x0: 0, x1: 1,
            yref: 'y', y0: 0.5, y1: 0.5,
            line: { color: isDark ? 'rgba(200,200,210,0.45)' : 'rgba(100,100,100,0.4)', width: 1.5, dash: 'dash' },
        }],
        annotations: [{
            xref: 'paper', x: 1, xanchor: 'right',
            yref: 'y', y: 0.5, yanchor: 'bottom',
            text: 'chance (50%)', showarrow: false,
            font: { size: 11, color: isDark ? 'rgba(200,200,210,0.6)' : 'rgba(100,100,100,0.6)' },
        }],
    };
    Plotly.newPlot('mc-gam-chart', gamTraces, gamLayout, { displayModeBar: false, responsive: true });
    const pNote = (st.p_val !== null && st.p_val !== undefined)
        ? (st.p_val < 0.001 ? 'p < .001' : 'p = ' + st.p_val.toFixed(3))
        : '';
    document.getElementById('mc-gam-stats').innerHTML =
        'Logistic smooth — edf = ' + st.edf +
        ', χ² = ' + st.chi_sq +
        (pNote ? ', ' + pNote : '') +
        ' — McFadden R² = ' + st.r2 +
        ' — N = ' + st.n_model + ' (successful vs. failed)';
}

async function loadMeanCitedness() {
    const loadingEl  = document.getElementById('mc-loading');
    const overviewEl = document.getElementById('mc-overview');
    const distCard   = document.getElementById('mc-dist-card');
    const gamCard    = document.getElementById('mc-gam-card');
    const errorEl    = document.getElementById('mc-error');
    try {
        const res = await fetch(IMPACT_DATA_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        loadingEl.style.display  = 'none';
        overviewEl.style.display = '';
        distCard.style.display   = '';
        gamCard.style.display    = '';
        renderMcCharts(data);
    } catch (err) {
        console.warn('Mean Citedness load failed:', err);
        loadingEl.style.display = 'none';
        errorEl.style.display   = 'block';
        const det = document.getElementById('mc-error-detail');
        if (det) det.textContent = String(err);
    }
}
document.getElementById('mc-tab').addEventListener('shown.bs.tab', loadMeanCitedness);

// ===== Authorship Overlap tab =====
window._aoData = null;

function aoPlotlyTheme() {
    const dark = currentTheme() === 'dark';
    return {
        paper: dark ? '#1d1e29' : '#ffffff',
        plot:  dark ? '#1d1e29' : '#ffffff',
        grid:  dark ? '#2d2e3d' : '#eeeaef',
        font:  dark ? '#e8e6ee' : '#2a2330',
    };
}

function renderOverlapCharts(d) {
    if (!d) return;
    const th = aoPlotlyTheme();
    const ov = d.overview;
    const by = d.by_outcome;

    // ── Overview boxes ─────────────────────────────────────────────────────────
    const ovEl = document.getElementById('ao-overview');
    if (ovEl) {
        ovEl.innerHTML =
            '<div class="mc-stat-box">' +
                '<div class="mc-stat-value">' + (ov.n_total || 0).toLocaleString() + '</div>' +
                '<div class="mc-stat-label">Replications included</div>' +
            '</div>' +
            '<div class="mc-stat-box">' +
                '<div class="mc-stat-value">' + (ov.n_overlap || 0).toLocaleString() + '</div>' +
                '<div class="mc-stat-label">With author overlap (' + (ov.pct_overlap || 0) + '%)</div>' +
            '</div>' +
            '<div class="mc-stat-box">' +
                '<div class="mc-stat-value">' + (ov.n_no_overlap || 0).toLocaleString() + '</div>' +
                '<div class="mc-stat-label">Without author overlap (' + (ov.pct_no_overlap || 0) + '%)</div>' +
            '</div>' +
            '<div class="mc-stat-box">' +
                '<div class="mc-stat-value">' + (ov.n_unknown || 0).toLocaleString() + '</div>' +
                '<div class="mc-stat-label">Overlap unknown</div>' +
            '</div>';
        ovEl.style.display = '';
    }

    // ── Grouped bar chart ──────────────────────────────────────────────────────
    const OUTCOMES   = ['successful', 'failed', 'mixed', 'inconclusive'];
    const OUT_LABELS = { successful: 'Successful', failed: 'Failed', mixed: 'Mixed', inconclusive: 'Inconclusive' };
    const groups     = ['overlap', 'no_overlap'];
    const GROUP_LABELS = { overlap: 'Author overlap', no_overlap: 'No author overlap' };

    const traces = OUTCOMES.map(oc => ({
        name: OUT_LABELS[oc],
        type: 'bar',
        x: groups.map(g => GROUP_LABELS[g]),
        y: groups.map(g => (by[g] && by[g][oc]) || 0),
        marker: { color: OUTCOME_COLORS[oc] || '#a0a7b4' },
    }));

    const layout = {
        barmode: 'group',
        height: 420,
        paper_bgcolor: th.paper,
        plot_bgcolor:  th.plot,
        font: { color: th.font, size: 13 },
        legend: { orientation: 'h', y: -0.18, font: { color: th.font } },
        margin: { l: 50, r: 20, t: 20, b: 80 },
        yaxis: {
            title: 'Number of replications',
            gridcolor: th.grid,
            zerolinecolor: th.grid,
            tickfont: { color: th.font },
            titlefont: { color: th.font },
        },
        xaxis: {
            tickfont: { color: th.font },
        },
    };

    const config = { responsive: true, displayModeBar: false };
    const chartEl = document.getElementById('ao-chart');
    if (chartEl) Plotly.react(chartEl, traces, layout, config);

    // ── Caveat ─────────────────────────────────────────────────────────────────
    const caveatEl = document.getElementById('ao-caveat');
    if (caveatEl) caveatEl.style.display = '';
}

async function loadAuthorOverlap() {
    if (window._aoData) { renderOverlapCharts(window._aoData); return; }
    const loadingEl  = document.getElementById('ao-loading');
    const overviewEl = document.getElementById('ao-overview');
    const chartCard  = document.getElementById('ao-chart-card');
    const caveatEl   = document.getElementById('ao-caveat');
    const errorEl    = document.getElementById('ao-error');
    try {
        if (loadingEl)  loadingEl.style.display  = 'block';
        if (overviewEl) overviewEl.style.display = 'none';
        if (chartCard)  chartCard.style.display  = 'none';
        if (caveatEl)   caveatEl.style.display   = 'none';
        if (errorEl)    errorEl.style.display    = 'none';

        const res = await fetch(OVERLAP_DATA_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        window._aoData = d;

        if (loadingEl)  loadingEl.style.display  = 'none';
        if (chartCard)  chartCard.style.display  = '';
        renderOverlapCharts(d);
    } catch (err) {
        if (loadingEl)  loadingEl.style.display  = 'none';
        if (errorEl)    errorEl.style.display    = 'block';
        const det = document.getElementById('ao-error-detail');
        if (det) det.textContent = String(err);
    }
}
document.getElementById('overlap-tab').addEventListener('shown.bs.tab', loadAuthorOverlap);

// ===== Data stamps (last updated) =====
const OVERLAP_DATA_URL = 'data/author_overlap_data.json';
const OVERLAP_META_URL = 'data/author_overlap_meta.json';

const STAMP_LABELS = {
    flora: 'FLoRA data',
    citations: 'Citation data',
    impact_factor: 'Mean Citedness analysis',
    author_overlap: 'Authorship Overlap data'
};
const STAMP_URLS = {
    flora: FLORA_META_URL,
    citations: CITATIONS_META_URL,
    impact_factor: IMPACT_META_URL,
    author_overlap: OVERLAP_META_URL
};

async function loadDataStamps() {
    const cache = {};
    const sources = Array.from(new Set(Array.from(document.querySelectorAll('.data-stamp')).map(el => el.dataset.stampSource)));
    await Promise.all(sources.map(async src => {
        try {
            const res = await fetch(STAMP_URLS[src], { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            cache[src] = await res.json();
        } catch (e) {
            cache[src] = null;
        }
    }));

    document.querySelectorAll('.data-stamp').forEach(el => {
        const src = el.dataset.stampSource;
        const meta = cache[src];
        const label = STAMP_LABELS[src] || 'Data';
        if (meta && meta.last_updated) {
            const dt = new Date(meta.last_updated);
            const ageMs = Date.now() - dt.getTime();
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            const stale = (src === 'citations' || src === 'impact_factor') ? ageDays > 14 : ageDays > 3;
            el.classList.toggle('stale', stale);
            const fmt = dt.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            el.innerHTML = `${label} last updated: <strong>${fmt}</strong>`;
            if (meta.source_url) el.innerHTML += ` · <a class="doi-link" href="${meta.source_url}" target="_blank">source</a>`;
        } else {
            el.classList.add('missing');
            el.innerHTML = `${label}: <em>no snapshot yet</em>`;
        }
    });
}

// ===== Main load =====
async function loadDisciplines() {
    try {
        const res = await fetch(DISCIPLINES_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        DISCIPLINES = await res.json();
    } catch (e) {
        console.warn('Could not load disciplines.json; field aggregation will use Uncategorized only.', e);
        DISCIPLINES = {};
    }
    JOURNAL_TO_DISCIPLINE = {};
    for (const [disc, journals] of Object.entries(DISCIPLINES)) {
        for (const j of journals) JOURNAL_TO_DISCIPLINE[j.toLowerCase().trim()] = disc;
    }
}

function parseCsvFromUrl(url) {
    return new Promise((resolve, reject) => {
        Papa.parse(url, {
            download: true, header: true, skipEmptyLines: true,
            complete: results => resolve(results),
            error: err => reject(err)
        });
    });
}

async function loadData() {
    await loadDisciplines();

    let results;
    try {
        results = await parseCsvFromUrl(LOCAL_CSV_URL);
        if (!results.data || results.data.length === 0) throw new Error('empty');
    } catch (e) {
        console.info('Local flora.csv not available, falling back to upstream raw URL');
        try {
            results = await parseCsvFromUrl(REMOTE_CSV_URL);
        } catch (e2) {
            document.getElementById('global-loading').style.display = 'none';
            const err = document.getElementById('global-error');
            err.style.display = 'block';
            err.textContent = 'Error loading FLoRA data: ' + (e2.message || e2);
            return;
        }
    }

    if (results.errors && results.errors.length > 0) console.warn('CSV parsing warnings:', results.errors);
    const data = results.data.map(row => {
        Object.keys(row).forEach(key => { if (row[key] === 'NA') row[key] = ''; });
        return row;
    });
    fullRowData = data;

    document.getElementById('global-loading').style.display = 'none';
    document.getElementById('floraTabsContent').style.display = 'block';

    updateOverviewStats(data);
    renderOverviewChart(data);
    renderRandomExamples(data);
    initDataTable(data);
    setupBrowseMobile(data);
    setupBrowseKindFilter();
    loadCitation();
    loadFaqs();
    loadDataStamps();
    applyTabFromUrl();
}

// Map friendly ?tab= values to the Bootstrap tab buttons.
const TAB_PARAM_MAP = {
    overview: 'overview-tab',
    browse: 'browse-tab',
    trends: 'trends-tab', years: 'trends-tab', disciplines: 'trends-tab',
    citations: 'citation-tab', 'citation-impact': 'citation-tab',
    'mean-citedness': 'mc-tab', omc: 'mc-tab',
    'authorship-overlap': 'overlap-tab', overlap: 'overlap-tab'
};

// Canonical ?tab= value for each tab button (the reverse of TAB_PARAM_MAP).
const TAB_ID_TO_PARAM = {
    'overview-tab': 'overview', 'browse-tab': 'browse', 'trends-tab': 'trends',
    'citation-tab': 'citations', 'mc-tab': 'mean-citedness', 'overlap-tab': 'authorship-overlap'
};

// Select a tab from the ?tab= URL param (e.g. ?tab=citations). Activating the
// tab fires shown.bs.tab, which lazy-loads that tab's content as usual.
function applyTabFromUrl() {
    const tab = (new URLSearchParams(window.location.search).get('tab') || '').toLowerCase();
    if (!tab) return;
    const btn = document.getElementById(TAB_PARAM_MAP[tab] || '');
    if (btn && window.bootstrap) bootstrap.Tab.getOrCreateInstance(btn).show();
}

// Reflect the active tab in the address bar so it stays shareable as the user
// navigates. Fires for both clicks and programmatic shows.
function syncTabToUrl(tabId) {
    const name = TAB_ID_TO_PARAM[tabId];
    if (!name) return;
    const params = new URLSearchParams(window.location.search);
    if (name !== 'citations') params.delete('doi');   // doi only applies to Citation Impact
    if (name === 'overview') params.delete('tab');     // keep the home URL clean
    else params.set('tab', name);
    const qs = params.toString();
    history.replaceState(null, '', new URL('./' + (qs ? '?' + qs : ''), window.location.href).href);
}
Object.keys(TAB_ID_TO_PARAM).forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('shown.bs.tab', () => syncTabToUrl(id));
});

$(document).ready(loadData);
