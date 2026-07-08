/* FLoRA Explorer: Citation Impact tab
   Loads weekly-refreshed OpenCitations data and renders KPIs, event-study
   plots, and a browsable per-original table. Adapted from flora-citations. */

(function() {
    const CI = {
        meta: null, agg: null, studies: null, index: null, fect: null, cocitBreakdown: null,
        outcome: 'all', page: 1, perPage: 20,
        sortCol: 'n_citations', sortDir: 'desc',
        loaded: false, loading: false
    };

    const OUTCOME_COLORS = {
        failed: '#b3331e', successful: '#2f8f4f', mixed: '#d49b1d', all: '#8b1a4a'
    };

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function formatAuthors(raw, max = 3) {
        if (!raw) return '';
        if (typeof raw !== 'string') { try { raw = JSON.stringify(raw); } catch (e) { return ''; } }
        const s = raw.trim(); if (!s) return '';
        if (!s.startsWith('[') && !s.includes('"family"') && !s.includes("'family'")) return s.slice(0, 200);
        let parsed = null;
        try { parsed = JSON.parse(s.replace(/'/g, '"')); } catch (e) {}
        let names = [];
        if (Array.isArray(parsed)) names = parsed.map(extractName).filter(Boolean);
        else {
            const re = /"given"\s*:\s*"([^"]*)"[^}]*?"family"\s*:\s*"([^"]*)"|"family"\s*:\s*"([^"]*)"[^}]*?"given"\s*:\s*"([^"]*)"|"family"\s*:\s*"([^"]*)"/g;
            let m;
            while ((m = re.exec(s)) !== null) {
                const given = m[1] || m[4] || '';
                const family = m[2] || m[3] || m[5] || '';
                const name = formatOne(family, given);
                if (name) names.push(name);
            }
        }
        if (names.length === 0) return s.slice(0, 200);
        if (names.length <= max) return names.join('; ');
        return names.slice(0, max).join('; ') + `, … (+${names.length - max})`;
    }
    function extractName(a) { if (!a || typeof a !== 'object') return ''; return formatOne(a.family || a.last || '', a.given || a.first || ''); }
    function formatOne(family, given) {
        family = (family || '').trim(); given = (given || '').trim();
        if (!family) return '';
        const initials = given.split(/\s+/).map(p => (p && p[0] ? p[0].toUpperCase() + '.' : '')).join(' ').trim();
        return initials ? `${family}, ${initials}` : family;
    }

    function plotlyTheme() {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        return {
            paper: dark ? '#1d1e29' : '#ffffff',
            plot:  dark ? '#1d1e29' : '#ffffff',
            grid:  dark ? '#2d2e3d' : '#eeeaef',
            font:  dark ? '#e8e6ee' : '#2a2330',
            muted: dark ? '#9793a4' : '#6f7686'
        };
    }

    async function init() {
        if (CI.loaded || CI.loading) return;
        CI.loading = true;
        try {
            const [metaRes, aggRes, origRes] = await Promise.all([
                fetch('data/meta.json'),
                fetch('data/aggregate.json'),
                fetch('data/originals.json')
            ]);
            if (!metaRes.ok || !aggRes.ok || !origRes.ok) { showPlaceholder(); return; }
            CI.meta = await metaRes.json();
            CI.agg = await aggRes.json();
            const originals = await origRes.json();
            CI.studies = originals.studies;
            CI.index = originals.index.map(s => {
                // Denominator is citations since the first replication, not lifetime
                // citations — citing works published before any replication existed
                // could never have co-cited one.
                const cocit_prop = s.n_citations_post_first_rep > 0 ? s.n_cocitations / s.n_citations_post_first_rep : 0;
                return { ...s, cocit_prop };
            });

            // Optional: ETWFE results (may not exist on first run)
            try {
                const fectRes = await fetch('data/fect_results.json');
                if (fectRes.ok) CI.fect = await fectRes.json();
            } catch (_) {}

            // Optional: co-citation breakdown by pub status / outcome (may not exist on first run)
            try {
                const breakdownRes = await fetch('data/cocit_breakdown.json');
                if (breakdownRes.ok) CI.cocitBreakdown = await breakdownRes.json();
            } catch (_) {}

            renderKPIs(); renderAggregate(); renderTable(); renderCocitBreakdown(); bindEvents();
            CI.loaded = true;
        } catch (e) {
            console.error('Citation Impact load failed:', e);
            showPlaceholder();
        } finally {
            CI.loading = false;
        }
    }

    function showPlaceholder() {
        const msg = `
            <div style="padding:24px;background:var(--flora-card-bg);border:1px solid var(--flora-border);
                        border-radius:8px;text-align:center;color:var(--flora-muted);grid-column:1 / -1">
              ⏳ <strong>Citation data not yet available.</strong><br>
              The first weekly refresh has not completed yet (or the workflow secrets are not set).
              This panel will populate automatically once the GitHub Action
              <code>refresh-data.yml</code> finishes.
            </div>`;
        const kpis = document.getElementById('kpis'); if (kpis) kpis.innerHTML = msg;
        ['plot-cit', 'plot-cocit'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<div style="padding:80px 20px;text-align:center;color:var(--flora-muted)">No data yet</div>';
        });
        const tbody = document.querySelector('#originals-table tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--flora-muted)">No data yet. First refresh in progress.</td></tr>';
    }

    function renderKPIs() {
        const c = (CI.meta && CI.meta.outcome_counts) || {};
        const fmt = n => (n == null ? '—' : Number(n).toLocaleString());
        document.getElementById('kpis').innerHTML = `
            <div class="kpi"><div class="kpi-value">${fmt(CI.meta && CI.meta.n_originals)}</div><div class="kpi-label">Original studies</div></div>
            <div class="kpi"><div class="kpi-value">${fmt(CI.meta && CI.meta.n_replications)}</div><div class="kpi-label">Replication attempts</div></div>
            <div class="kpi"><div class="kpi-value">${fmt(c.failed)}</div><div class="kpi-label">Failed replications</div></div>
            <div class="kpi"><div class="kpi-value">${fmt(c.successful)}</div><div class="kpi-label">Successful replications</div></div>`;
    }

    function renderAggregate() {
        const data = CI.agg[CI.outcome]; if (!data) return;
        drawAggregatePlot('plot-cit', data, 'mean_citations', 'citations_model', 'Mean citations per year', CI.outcome);
        drawAggregatePlot('plot-cocit', data, 'mean_cocitations', 'cocitations_model', 'Mean co-citations per year', CI.outcome);

        const model = data.citations_model || {}; const desc = data.descriptive || {};
        let html;
        const hasModel = model.att != null && Number.isFinite(model.att);
        if (hasModel) {
            const pctNum = (Math.exp(model.att) - 1) * 100;
            const ci = (model.att_ci || []).filter(v => v != null && Number.isFinite(v));
            const ciLNum = ci.length === 2 ? (Math.exp(ci[0]) - 1) * 100 : null;
            const ciHNum = ci.length === 2 ? (Math.exp(ci[1]) - 1) * 100 : null;
            const ciL = ciLNum !== null ? ciLNum.toFixed(1) : '?';
            const ciH = ciHNum !== null ? ciHNum.toFixed(1) : '?';
            const notSig = ciLNum !== null && ciHNum !== null && ciLNum < 0 && ciHNum > 0;
            const direction = pctNum >= 0 ? 'higher' : 'lower';
            const gloss = '<span class="gloss" tabindex="0">Average post-replication effect on citations<span class="gloss-tip">Compares citation counts in the years after the first replication to the year just before it (t = -1), controlling for study and year fixed effects.</span></span>';
            html = `<strong>${gloss}:</strong>
                citations were an estimated <strong>${Math.abs(pctNum).toFixed(1)}% ${direction}</strong> after the first replication than in the year before it
                (95% CI: ${ciL}%, ${ciH}%)${notSig ? ' — <span class="muted">not statistically distinguishable from no change</span>' : ''}
                · <span class="muted">based on ${model.n_units} originals</span>`;
        } else if (desc.n_units && desc.n_units.length) {
            const maxN = Math.max(...desc.n_units);
            html = `<strong>Descriptive trajectory shown.</strong>
                <span class="muted">${maxN.toLocaleString()} originals contribute at peak. Each line shows the average citation count by years relative to the first replication.</span>`;
        } else {
            html = `<strong>Insufficient data</strong> for the selected outcome group.`;
        }
        document.getElementById('att-callout').innerHTML = html;
    }

    function drawAggregatePlot(divId, data, descField, modelField, ylabel, outcome) {
        const desc = data.descriptive || {}; const model = data[modelField] || {};
        const color = OUTCOME_COLORS[outcome] || OUTCOME_COLORS.all;
        const traces = [];

        if (desc.event_time && desc.event_time.length) {
            traces.push({
                x: desc.event_time, y: desc[descField], type: 'scatter', mode: 'lines+markers',
                line: { color, width: 2.5 }, marker: { color, size: 7 },
                name: 'Mean (raw)', hovertemplate: 't=%{x} years: %{y:.2f}<extra></extra>'
            });
        }
        if (desc.event_time && desc.n_units && desc.n_units.length) {
            traces.push({
                x: desc.event_time, y: desc.n_units, type: 'scatter', mode: 'lines',
                line: { color: '#bbb', width: 1, dash: 'dot' },
                name: 'N (right axis)', yaxis: 'y2',
                hovertemplate: 't=%{x}: N=%{y}<extra></extra>'
            });
        }
        if (model.event_time && model.estimate && model.estimate.some(v => v != null && Number.isFinite(v))) {
            const refIdx = desc.event_time ? desc.event_time.indexOf(-1) : -1;
            const baseline = refIdx >= 0 ? desc[descField][refIdx] : null;
            if (baseline) {
                traces.push({
                    x: model.event_time,
                    y: model.estimate.map(e => e == null || !Number.isFinite(e) ? null : Math.exp(e) * baseline),
                    type: 'scatter', mode: 'lines',
                    line: { color: plotlyTheme().font, width: 1.5, dash: 'dot' },
                    name: 'Model fit (OLS)', hoverinfo: 'skip'
                });
            }
        }

        // ETWFE overlay (optional, only shown when fect_results.json exists)
        const fectKey = modelField === 'citations_model' ? 'citations' : 'cocitations';
        const fect = CI.fect && CI.fect[outcome] && CI.fect[outcome][fectKey];
        if (fect && fect.event_time && fect.event_time.length > 0) {
            const refIdx = desc.event_time ? desc.event_time.indexOf(-1) : -1;
            const baseline = refIdx >= 0 ? desc[descField][refIdx] : 0;
            const fectColor = '#4a74b4';
            const fectColorAlpha = 'rgba(74,116,180,0.15)';
            // CI band: lower bound first (invisible), then upper bound fills back to it
            traces.push({
                x: fect.event_time,
                y: fect.att_lo.map(v => baseline + (v || 0)),
                type: 'scatter', mode: 'lines',
                line: { width: 0 }, showlegend: false,
                hoverinfo: 'skip', name: '_fect_lo'
            });
            traces.push({
                x: fect.event_time,
                y: fect.att_hi.map(v => baseline + (v || 0)),
                type: 'scatter', mode: 'lines', fill: 'tonexty',
                fillcolor: fectColorAlpha, line: { width: 0 },
                showlegend: false, hoverinfo: 'skip', name: '_fect_hi'
            });
            traces.push({
                x: fect.event_time,
                y: fect.att_est.map(v => baseline + (v || 0)),
                type: 'scatter', mode: 'lines',
                line: { color: fectColor, width: 2, dash: 'dashdot' },
                name: `ETWFE (n=${fect.n_units})`,
                hovertemplate: 't=%{x}: %{y:.2f}<extra>ETWFE causal est.</extra>'
            });
        }

        if (traces.length === 0) {
            document.getElementById(divId).innerHTML = '<div style="padding:60px;text-align:center;color:var(--flora-muted)">No data for this filter</div>';
            return;
        }

        const t = plotlyTheme();
        const layout = {
            margin: { t: 30, r: 50, b: 50, l: 60 },
            xaxis: { title: 'Years relative to first replication', zeroline: false, gridcolor: t.grid, color: t.font },
            yaxis: { title: ylabel, gridcolor: t.grid, color: t.font, rangemode: 'tozero' },
            yaxis2: {
                title: 'N studies', overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero',
                tickfont: { color: t.muted, size: 10 }, titlefont: { color: t.muted, size: 10 }
            },
            shapes: [{ type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: '#8b1a4a', width: 1.5, dash: 'dash' } }],
            annotations: [{ x: 0, yref: 'paper', y: 1.04, xref: 'x', yanchor: 'bottom', text: 'Replication published', showarrow: false, font: { size: 11, color: '#8b1a4a' } }],
            plot_bgcolor: t.plot, paper_bgcolor: t.paper,
            font: { family: 'Inter, sans-serif', size: 12, color: t.font },
            legend: { orientation: 'h', y: -0.22, font: { color: t.font } }
        };
        Plotly.newPlot(divId, traces, layout, { displayModeBar: false, responsive: true });
    }

    function renderOutcomeBar(outcomeMix, nReplications) {
        if (!outcomeMix || !nReplications) return '—';
        const total = nReplications;
        const ORDERS = ['failed', 'mixed', 'successful'];
        const segments = ORDERS.map(o => {
            const count = outcomeMix[o] || 0;
            if (!count) return '';
            const pct = (count / total * 100).toFixed(1);
            const label = `${count} ${o}`;
            return `<div class="rep-seg ${o}" style="width:${pct}%" title="${label}"></div>`;
        }).join('');
        const tooltipParts = ORDERS.filter(o => outcomeMix[o]).map(o => `${outcomeMix[o]} ${o}`).join(', ');
        return `<div class="rep-bar-wrap" title="${tooltipParts}">
            <div class="rep-bar">${segments}</div>
            <span class="rep-count">${total}</span>
        </div>`;
    }

    const PUBSTATUS_LABELS = {
        individual: 'Individual', large_project: 'Large project (>3 originals)', unpublished: 'Preprint only'
    };
    const BREAKDOWN_OUTCOME_LABELS = { successful: 'Successful', failed: 'Failed', mixed: 'Mixed' };

    function renderBreakdownTable(title, dim, labels, note) {
        const rows = Object.keys(labels).map(key => {
            const d = dim[key] || {};
            const fmt = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
            return `<tr>
                <td>${labels[key]}</td>
                <td>${d.n_originals != null ? d.n_originals.toLocaleString() : '—'}</td>
                <td>${fmt(d.mean_rate)}</td>
                <td>${fmt(d.median_rate)}</td>
                <td>${fmt(d.grand_mean_rate)}</td>
            </tr>`;
        }).join('');
        return `<div class="cocit-breakdown-table">
            <h4>${title}</h4>
            <table>
                <thead><tr><th>Group</th><th>N originals</th><th>Per-paper mean</th><th>Median</th><th>Weighted mean</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            ${note ? `<p class="cocit-breakdown-note">${note}</p>` : ''}
        </div>`;
    }

    function renderCocitBreakdown() {
        const el = document.getElementById('cocit-breakdown');
        if (!el) return;
        const bd = CI.cocitBreakdown;
        if (!bd) { el.innerHTML = '<p class="muted">Not available yet — this analysis is included from the next scheduled data refresh.</p>'; return; }
        el.innerHTML =
            renderBreakdownTable('By publication status of the replication', bd.pub_status || {}, PUBSTATUS_LABELS) +
            renderBreakdownTable('By outcome of the replication', bd.outcome || {}, BREAKDOWN_OUTCOME_LABELS);
    }

    function renderCocitCell(s) {
        if (!s.n_cocitations && s.n_cocitations !== 0) return '—';
        const denom = s.n_citations_post_first_rep;
        const pct = denom > 0 ? (s.cocit_prop * 100).toFixed(1) + '%' : '—';
        const tooltip = denom
            ? `${s.n_cocitations.toLocaleString()} of ${denom.toLocaleString()} citations since the first replication (${s.first_replication_year}) also cite a replication`
            : `${s.n_cocitations.toLocaleString()} co-citations`;
        return `<span title="${escapeHtml(tooltip)}">${s.n_cocitations.toLocaleString()}<span class="cocit-pct"> (${pct})</span></span>`;
    }

    function renderTable() {
        const q = (document.getElementById('search-input').value || '').toLowerCase();
        const outFilter = document.getElementById('filter-outcome').value;

        let rows = CI.index.filter(s => {
            if (q) {
                const hay = `${s.title} ${s.author} ${s.doi}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            if (outFilter && !(s.outcome_mix && s.outcome_mix[outFilter])) return false;
            return true;
        });

        const col = CI.sortCol, dir = CI.sortDir;
        rows.sort((a, b) => {
            const av = a[col] != null ? a[col] : -Infinity;
            const bv = b[col] != null ? b[col] : -Infinity;
            return dir === 'asc' ? av - bv : bv - av;
        });

        // Update header indicators
        document.querySelectorAll('#originals-table thead th[data-sort]').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
            if (th.dataset.sort === col) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
        });
        document.querySelectorAll('.cocit-sort-btn').forEach(btn => {
            btn.classList.remove('sort-asc', 'sort-desc');
            if (btn.dataset.sort === col) btn.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
        });

        const total = rows.length;
        const pages = Math.max(1, Math.ceil(total / CI.perPage));
        if (CI.page > pages) CI.page = 1;
        const start = (CI.page - 1) * CI.perPage;
        const slice = rows.slice(start, start + CI.perPage);

        const tbody = document.querySelector('#originals-table tbody');
        tbody.innerHTML = slice.map(s => {
            return `
                <tr data-doi="${escapeHtml(s.doi)}">
                    <td>
                        <div class="title-cell">${escapeHtml(s.title || '(untitled)')}</div>
                        <div class="author-cell">${escapeHtml(formatAuthors(s.author))} ${s.venue ? '· ' + escapeHtml(s.venue) : ''}</div>
                    </td>
                    <td>${s.year || '—'}</td>
                    <td>${renderOutcomeBar(s.outcome_mix, s.n_replications)}</td>
                    <td>${(s.n_citations || 0).toLocaleString()}</td>
                    <td>${renderCocitCell(s)}</td>
                    <td>›</td>
                </tr>`;
        }).join('');

        const pag = document.getElementById('pagination');
        const winSize = 5;
        const winStart = Math.max(1, CI.page - Math.floor(winSize / 2));
        const winEnd = Math.min(pages, winStart + winSize - 1);
        let pHtml = '';
        if (CI.page > 1) pHtml += `<button data-p="${CI.page - 1}">‹</button>`;
        for (let i = winStart; i <= winEnd; i++) pHtml += `<button data-p="${i}" class="${i === CI.page ? 'active' : ''}">${i}</button>`;
        if (CI.page < pages) pHtml += `<button data-p="${CI.page + 1}">›</button>`;
        pag.innerHTML = pHtml;
    }

    function showStudy(doi) {
        const s = CI.studies[doi]; if (!s) return;
        const reps = (s.replications || []).map(r => `
            <li>
                <span class="outcome-badge ${r.outcome}">${r.outcome}</span>
                <strong>${escapeHtml(formatAuthors(r.author, 2))} (${r.year || '?'})</strong>
                ${r.title ? '— ' + escapeHtml(r.title) : ''}
                ${r.doi ? `<br><a href="https://doi.org/${escapeHtml(r.doi)}" target="_blank" class="small">${escapeHtml(r.doi)}</a>` : ''}
            </li>`).join('');
        document.getElementById('ci-modal-body').innerHTML = `
            <div class="modal-body">
                <h2>${escapeHtml(s.title || '(untitled)')}</h2>
                <p class="muted">${escapeHtml(formatAuthors(s.author))} · ${s.year || '?'}
                    ${s.venue ? '· ' + escapeHtml(s.venue) : ''}<br>
                    <a href="https://doi.org/${escapeHtml(s.doi)}" target="_blank">${escapeHtml(s.doi)}</a></p>
                <button type="button" class="ci-share-btn" data-doi="${escapeHtml(s.doi)}">🔗 Copy link to this chart</button>
                <h3 style="margin-top:18px">Citation timeline</h3>
                ${s.cocit_conflated ? `<p class="cocit-warning">⚠️ Co-citation can't be measured for ${s.cocit_conflated > 1 ? 'some replications of ' : ''}this study: OpenCitations groups the original and ${s.cocit_conflated > 1 ? 'those replications' : 'its replication'} under one record, so citations of the two can't be told apart. The timeline below counts all of them as citations of the original.</p>` : ''}
                <div id="study-plot" style="width:100%;height:380px"></div>
                <h3 style="margin-top:18px">Replications (${s.n_replications})</h3>
                <ul class="rep-list">${reps}</ul>
            </div>`;
        document.getElementById('ci-modal').hidden = false;
        // Reflect the open chart in the address bar so it's directly shareable.
        history.replaceState(null, '', citationLink(s.doi));
        drawStudyTimeline(s);
    }

    function closeModal() {
        document.getElementById('ci-modal').hidden = true;
        // Drop ?doi= but keep the user on the Citation Impact tab.
        history.replaceState(null, '', new URL('./?tab=citations', window.location.href).href);
    }

    function drawStudyTimeline(s) {
        const tl = s.timeline || [];
        if (tl.length === 0) {
            document.getElementById('study-plot').innerHTML = '<div style="padding:80px;text-align:center;color:var(--flora-muted)">No citation data available</div>';
            return;
        }
        const years = tl.map(t => t.year);
        const traces = [
            { x: years, y: tl.map(t => t.only),            name: 'Cites original only',    type: 'bar', marker: { color: '#9ca3af' } },
            { x: years, y: tl.map(t => t.with_failed),     name: 'Co-cites failed rep',    type: 'bar', marker: { color: OUTCOME_COLORS.failed } },
            { x: years, y: tl.map(t => t.with_mixed),      name: 'Co-cites mixed rep',     type: 'bar', marker: { color: OUTCOME_COLORS.mixed } },
            { x: years, y: tl.map(t => t.with_successful), name: 'Co-cites successful rep',type: 'bar', marker: { color: OUTCOME_COLORS.successful } }
        ];
        const shapes = []; const annotations = [];
        (s.replications || []).forEach((r, i) => {
            if (!r.year) return;
            shapes.push({ type: 'line', x0: r.year, x1: r.year, yref: 'paper', y0: 0, y1: 1, line: { color: OUTCOME_COLORS[r.outcome] || '#8b1a4a', width: 2, dash: 'dash' } });
            annotations.push({ x: r.year, yref: 'paper', y: 1.02 - (i % 3) * 0.06, text: `${r.outcome} rep ${r.year}`, showarrow: false, font: { size: 10, color: OUTCOME_COLORS[r.outcome] || '#8b1a4a' }, bgcolor: 'rgba(255,255,255,0.85)' });
        });
        const t = plotlyTheme();
        const layout = {
            barmode: 'stack', margin: { t: 50, r: 10, b: 40, l: 50 },
            xaxis: { title: 'Year', gridcolor: t.grid, color: t.font },
            yaxis: { title: 'Citing preprints / papers', gridcolor: t.grid, color: t.font },
            shapes, annotations,
            plot_bgcolor: t.plot, paper_bgcolor: t.paper,
            legend: { orientation: 'h', y: -0.18, font: { color: t.font } },
            font: { family: 'Inter, sans-serif', size: 12, color: t.font }
        };
        Plotly.newPlot('study-plot', traces, layout, { displayModeBar: false, responsive: true });
    }

    function bindEvents() {
        document.querySelectorAll('#outcome-chips .chip').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#outcome-chips .chip').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                CI.outcome = btn.dataset.value; renderAggregate();
            });
        });
        document.getElementById('search-input').addEventListener('input', () => { CI.page = 1; renderTable(); });
        document.getElementById('filter-outcome').addEventListener('change', () => { CI.page = 1; renderTable(); });
        function sortBy(col) {
            if (CI.sortCol === col) {
                CI.sortDir = CI.sortDir === 'desc' ? 'asc' : 'desc';
            } else {
                CI.sortCol = col;
                CI.sortDir = 'desc';
            }
            CI.page = 1;
            renderTable();
        }
        document.querySelectorAll('#originals-table thead th[data-sort]').forEach(th => {
            th.addEventListener('click', () => sortBy(th.dataset.sort));
        });
        document.querySelectorAll('.cocit-sort-btn').forEach(btn => {
            btn.addEventListener('click', () => sortBy(btn.dataset.sort));
        });
        document.querySelector('#originals-table tbody').addEventListener('click', e => {
            const tr = e.target.closest('tr');
            if (tr && tr.dataset.doi) showStudy(tr.dataset.doi);
        });
        document.getElementById('pagination').addEventListener('click', e => {
            if (e.target.dataset.p) { CI.page = +e.target.dataset.p; renderTable(); }
        });
        document.getElementById('ci-modal-body').addEventListener('click', e => {
            const btn = e.target.closest('.ci-share-btn');
            if (!btn) return;
            const link = citationLink(btn.dataset.doi);
            navigator.clipboard.writeText(link).then(() => {
                const orig = btn.textContent;
                btn.textContent = '✓ Link copied';
                setTimeout(() => { btn.textContent = orig; }, 1500);
            }).catch(() => window.prompt('Copy this link:', link));
        });
        document.getElementById('ci-modal-close').addEventListener('click', closeModal);
        document.getElementById('ci-modal').addEventListener('click', e => {
            if (e.target.id === 'ci-modal') closeModal();
        });
    }

    // Memoised loader so the deep-link handler can await the same in-flight
    // load that opening the tab triggers (avoids a load race).
    let initPromise = null;
    function ensureInit() {
        if (!initPromise) initPromise = init();
        return initPromise;
    }

    // ===== Deep-linking: /citations/?doi=<doi> opens a study's chart popup =====
    function normalizeDoi(doi) {
        return (doi || '').trim().toLowerCase()
            .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
            .replace(/^doi:/, '');
    }

    // Resolve a (possibly prefixed) DOI to the matching key in CI.studies.
    function findStudyDoi(doi) {
        const t = normalizeDoi(doi);
        if (!t || !CI.studies) return null;
        return Object.keys(CI.studies).find(d => normalizeDoi(d) === t) || null;
    }

    // Build the shareable ?tab=citations&doi=… URL on the main page, relative
    // so it works under the GitHub Pages project path (/flora-explorer/).
    function citationLink(doi) {
        return new URL('./?tab=citations&doi=' + encodeURIComponent(doi), window.location.href).href;
    }

    // Switch to the Citation Impact tab, ensure data is loaded, then open the
    // study's chart popup. Returns true if a matching study was found.
    async function openStudyByDoi(doi) {
        await ensureInit();
        const matchDoi = findStudyDoi(doi);
        if (!matchDoi) return false;
        const tabBtn = document.getElementById('citation-tab');
        if (tabBtn && window.bootstrap) bootstrap.Tab.getOrCreateInstance(tabBtn).show();
        showStudy(matchDoi);
        return true;
    }

    // Read ?doi= from the current URL and open the matching popup, if any.
    async function handleDeepLink() {
        const doi = new URLSearchParams(window.location.search).get('doi');
        if (doi) await openStudyByDoi(doi);
    }

    // Lazy-load when the user opens the tab
    document.getElementById('citation-tab').addEventListener('shown.bs.tab', ensureInit);

    // Open a study popup straight away if arrived via /citations/?doi=…
    handleDeepLink();

    // Re-theme Plotly plots on dark-mode toggle
    document.getElementById('theme-toggle').addEventListener('click', () => {
        if (CI.loaded) {
            // Tiny delay to let CSS variables update
            setTimeout(() => { renderAggregate(); }, 50);
        }
    });
})();
