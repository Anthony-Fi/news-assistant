async function loadDomainTerms() {
  try {
    const res = await fetch('/domain_terms.json', { cache: 'no-store' });
    if (!res.ok) return;
    domainTerms = await res.json();
  } catch (e) {
    // optional file; ignore errors
    domainTerms = null;
  }
}

function renderVideos(list) {
  const container = document.getElementById('videos');
  const countEl = document.getElementById('vidCount');
  container.innerHTML = '';
  const items = list || [];
  items.forEach((v) => {
    const label = document.createElement('div');
    label.className = 'list-group-item d-flex justify-content-between align-items-start';
    const badge = `<span class="badge bg-secondary me-2 text-uppercase">${(v.sourceType || 'other')}</span>`;
    const srcHost = (() => { try { return new URL(v.srcUrl, window.location.href).hostname; } catch { return ''; } })();
    label.innerHTML = `
      <div class="ms-2 me-auto">
        <div class="fw-semibold text-truncate" title="${v.title || ''}">${v.title || ''}</div>
        <div class="text-muted small">From: <a href="${v.pageUrl}" target="_blank">article</a> • <span>${srcHost}</span></div>
        <div class="small text-break">${v.srcUrl}</div>
      </div>
      ${badge}
    `;
    label.style.cursor = 'pointer';
    label.addEventListener('click', () => playVideo(v));
    container.appendChild(label);
  });
  if (countEl) {
    const total = Array.isArray(videos) ? videos.length : 0;
    countEl.textContent = items.length ? `(${items.length} of ${total})` : total ? `(0 of ${total})` : '';
  }
}

function videoTypeBucket(v) {
  const t = (v && v.sourceType ? v.sourceType : '').toLowerCase();
  if (t === 'youtube' || t === 'vimeo') return 'platform';
  if (t === 'mp4' || t === 'webm') return 'direct';
  if (t === 'm3u8') return 'stream';
  if (t === 'embed') return 'embed';
  return 'embed';
}

function applyVideoFilters(all) {
  let out = Array.isArray(all) ? [...all] : [];
  const playableOnly = !!(document.getElementById('vidPlayableOnly') && document.getElementById('vidPlayableOnly').checked);
  const uniquePerPage = !!(document.getElementById('vidUniquePerPage') && document.getElementById('vidUniquePerPage').checked);
  const fromSelectedOnly = !!(document.getElementById('vidFromSelectedOnly') && document.getElementById('vidFromSelectedOnly').checked);
  const typeSel = document.getElementById('vidType');
  const typeVal = typeSel ? typeSel.value : 'all';
  const qEl = document.getElementById('vidSearch');
  const q = (qEl && qEl.value ? qEl.value : '').toLowerCase().trim();

  // Type filter
  if (typeVal !== 'all') {
    out = out.filter(v => {
      const b = videoTypeBucket(v);
      if (typeVal === 'platform') return b === 'platform';
      if (typeVal === 'direct') return b === 'direct';
      if (typeVal === 'stream') return b === 'stream';
      if (typeVal === 'embed') return b === 'embed';
      return true;
    });
  }

  // Playable-only filter (exclude generic embeds/unknown)
  if (playableOnly) {
    out = out.filter(v => {
      const b = videoTypeBucket(v);
      return b === 'platform' || b === 'direct' || b === 'stream';
    });
  }

  // Keyword/domain filter
  if (q) {
    out = out.filter(v => {
      const title = (v.title || '').toLowerCase();
      const src = (v.srcUrl || '').toLowerCase();
      const page = (v.pageUrl || '').toLowerCase();
      const srcHost = (() => { try { return new URL(v.srcUrl, window.location.href).hostname.toLowerCase(); } catch { return ''; } })();
      const pageHost = (() => { try { return new URL(v.pageUrl, window.location.href).hostname.toLowerCase(); } catch { return ''; } })();
      return title.includes(q) || src.includes(q) || page.includes(q) || srcHost.includes(q) || pageHost.includes(q);
    });
  }

  // From selected only
  if (fromSelectedOnly) {
    const selected = new Set(getSelectedHeadlineUrls());
    out = out.filter(v => selected.has(v.pageUrl));
  }

  // Unique per page: choose the best per page by rank
  if (uniquePerPage) {
    const rank = (v) => {
      const b = videoTypeBucket(v);
      if (b === 'platform') return 3;
      if (b === 'direct') return 3;
      if (b === 'stream') return 2;
      return 1; // embed/other
    };
    const best = new Map();
    for (const v of out) {
      const key = v.pageUrl || v.srcUrl;
      const cur = best.get(key);
      if (!cur || rank(v) > rank(cur)) best.set(key, v);
    }
    out = Array.from(best.values());
  }

  // Sort: platform/direct first, then stream, then embed; stable by title
  const sortKey = (v) => {
    const b = videoTypeBucket(v);
    const prio = b === 'platform' ? 0 : (b === 'direct' ? 1 : (b === 'stream' ? 2 : 3));
    return `${prio}|${(v.title || '').toLowerCase()}`;
  };
  out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return out;
}

function updateVideoList() {
  renderVideos(applyVideoFilters(videos));
}

// --- Wire video filter controls ---
let _vidSearchTimer = null;
window.addEventListener('DOMContentLoaded', () => {
  const ids = ['vidPlayableOnly','vidUniquePerPage','vidFromSelectedOnly','vidType'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateVideoList);
  });
  const searchEl = document.getElementById('vidSearch');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(_vidSearchTimer);
      _vidSearchTimer = setTimeout(updateVideoList, 200);
    });
  }
  // Update when headline selections change (event delegation)
  const heads = document.getElementById('headlines');
  if (heads) {
    heads.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('input[type="checkbox"]')) updateVideoList();
    });
  }
});

function playVideo(v) {
  const video = document.getElementById('videoEl');
  const iframe = document.getElementById('iframePlayer');
  const status = document.getElementById('videoStatus');
  if (!v) return;
  status.textContent = v.pageUrl ? `From: ${v.pageUrl}` : '';
  // Reset
  video.pause();
  video.removeAttribute('src');
  while (video.firstChild) video.removeChild(video.firstChild);
  iframe.style.display = 'none';
  iframe.src = '';

  const type = (v.sourceType || '').toLowerCase();
  if (type === 'youtube' || type === 'vimeo' || type === 'embed' || (v.srcUrl || '').includes('youtube.com/embed') || (v.srcUrl || '').includes('vimeo.com')) {
    iframe.style.display = 'block';
    iframe.src = v.srcUrl;
    return;
  }
  // Direct media: use proxy to mitigate CORS
  const proxied = `/api/proxy-video?url=${encodeURIComponent(v.srcUrl)}`;
  if (type === 'm3u8') {
    // Use direct HLS URL (proxying playlists requires URL rewriting). Falls back to native.
    const direct = v.srcUrl;
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ maxBufferLength: 30 });
      hls.loadSource(direct);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(() => {});
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = direct;
      video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true });
    } else {
      status.textContent = 'HLS not supported in this browser.';
    }
  } else {
    // mp4/webm/other
    const source = document.createElement('source');
    source.src = proxied;
    if (type === 'mp4') source.type = 'video/mp4';
    if (type === 'webm') source.type = 'video/webm';
    video.appendChild(source);
    video.load();
    video.play().catch(() => {});
  }
}

function shouldUsePoliticsDomain(query) {
  const q = (query || '').toLowerCase();
  return /(politic|parliament|congress|senate|election|government|whitehall|downing\s+street)/i.test(q);
}

function inferRegionFromGroup() {
  try {
    const sel = document.getElementById('feedGroup');
    const g = (sel && sel.value ? sel.value : '').toLowerCase();
    if (!g) return null;
    if (/(^|[_\-\s])(uk|brit|eng|wales|scot)/.test(g)) return 'uk';
    if (/(^|[_\-\s])(us|usa|america|states)/.test(g)) return 'usa';
    if (/(^|[_\-\s])(eu|europe|european)/.test(g)) return 'eu';
    return null;
  } catch { return null; }
}

function detectRegionsFromQuery(query) {
  const q = (query || '').toLowerCase();
  const regions = new Set();
  if (/(\buk\b|united\s+kingdom|british|england|scotland|wales|northern\s+ireland)/.test(q)) regions.add('uk');
  if (/(\busa\b|\bus\b|united\s+states|america|american)/.test(q)) regions.add('usa');
  if (/(\beu\b|europe|european|european\s+union)/.test(q)) regions.add('eu');
  return regions;
}

function detectRegionsFromContext(query) {
  const regions = detectRegionsFromQuery(query);
  if (regions.size === 0) {
    const fromGroup = inferRegionFromGroup();
    if (fromGroup) regions.add(fromGroup);
  }
  return regions;
}

function buildQueryWithRegionHint(query, regions) {
  if (!regions || regions.size === 0) return query;
  const map = { uk: 'UK', usa: 'US/USA', eu: 'EU/Europe' };
  const r = [...regions].map(k => map[k] || k.toUpperCase()).join(', ');
  // Non-invasive hint appended to user query for the model
  return `${query} (focus strictly on ${r} politics; ignore unrelated international politics unless directly about ${r}).`;
}

function defaultRegionAnchors(region) {
  switch (region) {
    case 'uk':
      return ['uk','british','england','scotland','wales','northern ireland','westminster','downing street','whitehall','house of commons','house of lords','no 10','number 10'];
    case 'usa':
      return ['usa','us','american','washington','white house','capitol hill','senate','congress'];
    case 'eu':
      return ['eu','europe','european','brussels','strasbourg','commission'];
    default:
      return [];
  }
}

function expandQueryWithDomain(qparts, query) {
  if (!domainTerms) return qparts;
  // Currently support politics domain; can be extended later
  const out = { phrases: [...qparts.phrases], tokens: [...qparts.tokens], excludeTokens: [], anchorTokens: [] };
  if (domainTerms.politics && shouldUsePoliticsDomain(query)) {
    const p = domainTerms.politics;
    const regions = detectRegionsFromContext(query);
    const addTerm = (t) => {
      if (!t) return;
      const s = String(t).trim();
      if (!s) return;
      if (s.includes(' ')) {
        // phrase
        const low = s.toLowerCase();
        if (!out.phrases.some(ph => ph.toLowerCase() === low)) out.phrases.push(s);
      } else {
        const low = s.toLowerCase();
        if (!out.tokens.some(tok => tok.toLowerCase() === low) && !STOPWORDS.has(low) && low.length >= 2) out.tokens.push(s);
      }
    };
    const flattenValues = (obj) => {
      if (!obj) return [];
      if (Array.isArray(obj)) return obj;
      const all = [];
      for (const k of Object.keys(obj)) {
        const arr = obj[k];
        if (Array.isArray(arr)) all.push(...arr);
      }
      return all;
    };
    (p.synonyms || []).forEach(addTerm);
    // Compute the union of region keys across parties/institutions/people
    const regionKeySet = new Set();
    if (p.parties) Object.keys(p.parties).forEach(k => regionKeySet.add(k));
    if (p.institutions) Object.keys(p.institutions).forEach(k => regionKeySet.add(k));
    if (p.people) Object.keys(p.people).forEach(k => regionKeySet.add(k));
    const allRegions = Array.from(regionKeySet);
    // If a region is specified, prefer only those; otherwise include all
    const targetRegions = regions.size ? [...regions] : allRegions;
    const otherRegions = allRegions.filter(r => !regions.has(r));
    const addFromRegions = (obj) => {
      if (!obj) return;
      for (const r of targetRegions) {
        if (Array.isArray(obj[r])) obj[r].forEach(addTerm);
      }
    };
    addFromRegions(p.parties);
    addFromRegions(p.institutions);
    addFromRegions(p.people);
    // Build anchor tokens from selected regions (default anchors + region-specific entities)
    const anchorSet = new Set();
    for (const r of targetRegions) {
      defaultRegionAnchors(r).forEach(t => anchorSet.add(String(t).toLowerCase()));
      if (p.parties && Array.isArray(p.parties[r])) p.parties[r].forEach(t => anchorSet.add(String(t).toLowerCase()));
      if (p.institutions && Array.isArray(p.institutions[r])) p.institutions[r].forEach(t => anchorSet.add(String(t).toLowerCase()));
      if (p.people && Array.isArray(p.people[r])) p.people[r].forEach(t => anchorSet.add(String(t).toLowerCase()));
    }
    out.anchorTokens = Array.from(anchorSet);
    // Build exclusion tokens from non-selected regions to suppress cross-region matches
    const collectFromRegions = (obj) => {
      const list = [];
      if (!obj) return list;
      for (const r of otherRegions) {
        if (Array.isArray(obj[r])) list.push(...obj[r]);
      }
      return list;
    };
    out.excludeTokens.push(
      ...collectFromRegions(p.parties),
      ...collectFromRegions(p.institutions),
      ...collectFromRegions(p.people)
    );
    (p.related_terms || []).forEach(addTerm);
  }
  return out;
}
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg || '';
}

let headlines = [];
let scraped = [];
let domainTerms = null; // loaded from /domain_terms.json when available
let videos = [];

async function loadModels() {
  // Load available models and preselect last-used/default
  try {
    const mres = await fetch('/api/models');
    if (mres.ok) {
      const mdata = await mres.json();
      const msel = document.getElementById('model');
      if (!msel) return;
      const previous = msel.value; // current selection before reload
      const last = localStorage.getItem('lastModel');
      msel.innerHTML = '';
      const models = mdata.models || [];
      models.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        msel.appendChild(opt);
      });
      // Preferred selection order: last-used -> default -> previous -> first option
      if (last && models.includes(last)) {
        msel.value = last;
      } else if (mdata.default && models.includes(mdata.default)) {
        msel.value = mdata.default;
      } else if (previous && models.includes(previous)) {
        msel.value = previous;
      } else if (msel.options.length) {
        msel.selectedIndex = 0;
      }
    }
  } catch (e) {
    console.warn('Failed to load models', e);
  }
}

async function init() {
  // Load feed groups
  await loadFeedGroups();
  // Load models list
  await loadModels();
  // Load domain terms (optional)
  await loadDomainTerms();
}

async function loadFeedGroups() {
  try {
    const res = await fetch('/api/feed-groups');
    if (!res.ok) return;
    const data = await res.json();
    const sel = document.getElementById('feedGroup');
    const current = sel.value;
    sel.innerHTML = '';
    const groups = data.groups || [];
    groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g; opt.textContent = g;
      sel.appendChild(opt);
    });
    if (current && groups.includes(current)) {
      sel.value = current;
    } else if (sel.options.length) {
      sel.selectedIndex = 0;
    }
  } catch (e) {
    console.warn('Failed to load feed groups', e);
  }
}

function renderHeadlines(items, selectedIndices) {
  const container = document.getElementById('headlines');
  container.innerHTML = '';
  const selectedSet = new Set(selectedIndices || []);
  // Build a view model preserving original index; sort selected first
  const rows = items.map((it, idx) => ({ idx, it, sel: selectedSet.has(idx) }));
  rows.sort((a, b) => {
    if (a.sel !== b.sel) return a.sel ? -1 : 1; // selected first
    return a.idx - b.idx; // stable by original order
  });
  rows.forEach(row => {
    const it = row.it;
    const idx = row.idx;
    const a = document.createElement('label');
    a.className = 'list-group-item';
    a.innerHTML = `
      <input class="form-check-input me-1" type="checkbox" value="${idx}" ${row.sel ? 'checked' : ''}>
      <span class="fw-semibold">${it.title || ''}</span>
      <div class="text-muted">${it.source || ''}</div>
      <a href="${it.link}" target="_blank">${it.link}</a>
    `;
    container.appendChild(a);
  });
}

function getSelectedHeadlineUrls() {
  const checks = document.querySelectorAll('#headlines input[type=checkbox]:checked');
  const urls = [];
  checks.forEach(ch => {
    const idx = parseInt(ch.value, 10);
    if (!isNaN(idx) && headlines[idx]) urls.push(headlines[idx].link);
  });
  return urls;
}

function getSelectedModel() {
  const msel = document.getElementById('model');
  return msel && msel.value ? msel.value : undefined;
}

// --- Auto-select headlines mentioned in summary ---
const STOPWORDS = new Set(['the','a','an','of','for','and','to','in','on','at','with','from','by','about','as','is','are','was','were','be','been','it','this','that','these','those','you','your']);

function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokensFromTitle(title) {
  const norm = normalizeText(title);
  return norm.split(' ').filter(t => t && t.length >= 3 && !STOPWORDS.has(t));
}

// --- Light stemming helpers (very simple, conservative) ---
function simpleStem(w) {
  let s = w.toLowerCase();
  // common adverb/adjective/verb endings
  const rules = [
    ['ically', 'ic'],
    ['ally', 'al'],
    ['ingly', 'ing'],
    ['iness', 'y'],
    ['fulness', 'ful'],
    ['ations', 'ation'],
    ['tional', 'tion'],
    ['ational', 'ation'],
    ['ively', 'ive'],
    ['ously', 'ous'],
    ['lessness', 'less'],
    ['ments', 'ment'],
    ['ment', 'ment'],
    ['ness', ''],
    ['less', 'less'],
    ['ships', 'ship'],
    ['ship', 'ship'],
    ['ings', 'ing'],
    ['ing', ''],
    ['ized', 'ize'],
    ['izes', 'ize'],
    ['izer', 'ize'],
    ['edly', 'ed'],
    ['edly', 'ed'],
    ['ed', ''],
    ['ers', 'er'],
    ['er', ''],
    ['ies', 'y'],
    ['ics', 'ic'],
    ['ical', 'ic'],
    ['ials', 'ial'],
    ['ial', 'ial'],
    ['als', 'al'],
    ['al', 'al'],
    ['s', '']
  ];
  for (const [suf, repl] of rules) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) {
      s = s.slice(0, -suf.length) + repl;
      break;
    }
  }
  return s;
}

function tokensFromText(text) {
  const norm = normalizeText(text);
  return norm.split(' ').filter(t => t && t.length >= 3 && !STOPWORDS.has(t));
}

function tokensContainStem(tokens, queryToken) {
  const q = simpleStem(queryToken);
  for (const tok of tokens) {
    const st = simpleStem(tok);
    if (st === q) return true;
    if (st.startsWith(q) && st.length - q.length <= 3) return true;
    if (q.startsWith(st) && q.length - st.length <= 2) return true;
  }
  return false;
}

function titleMatchScore(title, summaryNorm) {
  const toks = tokensFromTitle(title);
  if (!toks.length) return 0;
  let matches = 0;
  for (const t of toks) {
    if (summaryNorm.includes(` ${t} `) || summaryNorm.startsWith(t + ' ') || summaryNorm.endsWith(' ' + t) || summaryNorm === t) {
      matches++;
    }
  }
  return matches / toks.length;
}

function autoSelectFromSummary(summaryText, allowedIdxs) {
  const summaryNorm = ` ${normalizeText(summaryText)} `; // pad to ease word-boundary checks
  const allowed = allowedIdxs ? new Set(allowedIdxs) : null;
  let selectedCount = 0;
  const iterate = (allowed ? [...allowed] : headlines.map((_, i) => i));
  iterate.forEach((idx) => {
    const h = headlines[idx];
    if (!h) return;
    const title = h.title || '';
    const score = titleMatchScore(title, summaryNorm);
    // Heuristic: select if >= 0.5 of informative tokens match and at least 2 tokens
    const toks = tokensFromTitle(title);
    if (toks.length >= 2 && score >= 0.5) {
      const cb = document.querySelector(`#headlines input[type=checkbox][value="${idx}"]`);
      if (cb) {
        cb.checked = true;
        selectedCount++;
      }
    }
  });
  return selectedCount;
}

// --- Structured mentions selection (preferred) ---
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    url.search = '';
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch (e) {
    if (!u) return '';
    let s = String(u).trim();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  }
}

function urlsEqual(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}

function autoSelectByMentions(mentions, allowedIdxs) {
  const seen = new Set();
  const allowed = allowedIdxs ? new Set(allowedIdxs) : null;
  let count = 0;
  for (const m of (mentions || [])) {
    let idx = -1;
    if (m && typeof m === 'object') {
      if (m.url) {
        idx = headlines.findIndex(h => urlsEqual(h.link, m.url));
      }
      if (idx < 0 && Number.isInteger(m.index) && m.index >= 0 && m.index < headlines.length) {
        idx = m.index;
      }
      if (idx < 0 && m.title) {
        const tnorm = (m.title || '').trim().toLowerCase();
        idx = headlines.findIndex(h => (h.title || '').trim().toLowerCase() === tnorm);
        if (idx < 0) {
          // Weak fallback: contains match for longer titles
          idx = headlines.findIndex(h => (h.title || '').toLowerCase().includes(tnorm) && tnorm.length >= 8);
        }
      }
    } else if (typeof m === 'string') {
      if (m.startsWith('http')) {
        idx = headlines.findIndex(h => urlsEqual(h.link, m));
      } else {
        const tnorm = m.trim().toLowerCase();
        idx = headlines.findIndex(h => (h.title || '').trim().toLowerCase() === tnorm);
      }
    } else if (Number.isInteger(m)) {
      if (m >= 0 && m < headlines.length) idx = m;
    }
    if (idx >= 0 && !seen.has(idx) && (!allowed || allowed.has(idx))) {
      const cb = document.querySelector(`#headlines input[type=checkbox][value="${idx}"]`);
      if (cb) {
        cb.checked = true;
        seen.add(idx);
        count++;
      }
    }
  }
  return count;
}

// --- Query-driven headline search & ranking ---
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseQueryParts(q) {
  const phrases = [];
  const tokens = [];
  if (!q) return { phrases, tokens };
  let rest = q;
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    const ph = m[1].trim();
    if (ph) phrases.push(ph);
  }
  // remove phrases from the remaining string
  rest = q.replace(re, ' ');
  const rough = normalizeText(rest).split(' ').filter(Boolean);
  for (const t of rough) {
    if (t.length >= 3 && !STOPWORDS.has(t)) tokens.push(t);
  }
  return { phrases, tokens };
}

function headlineSearchScore(h, qparts) {
  const title = (h.title || '').toLowerCase();
  const summary = (h.summary || '').toLowerCase();
  const titleTokens = tokensFromText(title);
  const summaryTokens = tokensFromText(summary);
  let score = 0;
  let phraseHit = false;

  // phrase matches (exact substring, word-boundary at ends if simple words)
  for (const ph of qparts.phrases) {
    const phLow = ph.toLowerCase().trim();
    const re = new RegExp(escapeRegExp(phLow));
    if (re.test(title)) { score += 8; phraseHit = true; }
    if (re.test(summary)) { score += 4; phraseHit = true; }
  }

  // token matches with word boundaries
  let titleTokenHits = 0;
  let anyToken = false;
  for (const t of qparts.tokens) {
    const reWord = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i');
    const inTitle = reWord.test(title) || (t.length >= 4 && tokensContainStem(titleTokens, t));
    const inSummary = reWord.test(summary) || (t.length >= 4 && tokensContainStem(summaryTokens, t));
    if (inTitle) { score += 2; titleTokenHits++; anyToken = true; }
    if (inSummary) { score += 1; anyToken = true; }
  }
  if (titleTokenHits >= qparts.tokens.length && qparts.tokens.length > 0) score += 2; // all tokens in title

  // Heuristic threshold: phrase OR (>=2 title token hits) OR (token hits total >=3)
  const pass = phraseHit || titleTokenHits >= 2 || score >= 5;
  return pass ? score : 0;
}

function searchHeadlines(query, items, limit = 100) {
  let qparts = parseQueryParts(query);
  // Domain-aware expansion (e.g., politics)
  qparts = expandQueryWithDomain(qparts, query);
  if ((!qparts.phrases.length && !qparts.tokens.length) || !Array.isArray(items)) return [];
  const scored = [];
  for (let i = 0; i < items.length; i++) {
    let s = headlineSearchScore(items[i], qparts);
    if (s > 0 && Array.isArray(qparts.excludeTokens) && qparts.excludeTokens.length) {
      const combinedTokens = tokensFromText(`${items[i].title || ''} ${items[i].summary || ''}`);
      // Check for region anchors present in the headline
      let hasAnchor = false;
      if (Array.isArray(qparts.anchorTokens) && qparts.anchorTokens.length) {
        for (const a of qparts.anchorTokens) {
          if (tokensContainStem(combinedTokens, String(a).toLowerCase())) { hasAnchor = true; break; }
        }
      }
      for (const ex of qparts.excludeTokens) {
        if (tokensContainStem(combinedTokens, String(ex).toLowerCase())) {
          if (!hasAnchor) { s = 0; }
          break;
        }
      }
    }
    if (s > 0) scored.push({ index: i, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function selectByIndices(indices) {
  const set = new Set(indices);
  const boxes = document.querySelectorAll('#headlines input[type=checkbox]');
  boxes.forEach((cb) => {
    const idx = parseInt(cb.value, 10);
    cb.checked = set.has(idx);
  });
}

function clearAllSelections() {
  const boxes = document.querySelectorAll('#headlines input[type=checkbox]');
  boxes.forEach(cb => cb.checked = false);
}

function getSelectedIndices() {
  const checks = document.querySelectorAll('#headlines input[type=checkbox]:checked');
  const out = [];
  checks.forEach(ch => {
    const idx = parseInt(ch.value, 10);
    if (!isNaN(idx)) out.push(idx);
  });
  return out;
}

function reorderHeadlinesBySelection() {
  const selected = getSelectedIndices();
  renderHeadlines(headlines, selected);
}

// Event handlers

// Persist last-selected model
document.getElementById('model').addEventListener('change', (e) => {
  const val = e.target.value;
  if (val) localStorage.setItem('lastModel', val);
});

function buildPruneReport(resp, isDryRun) {
  try {
    const lines = [];
    lines.push(`# Auto-Prune ${isDryRun ? '(dry run)' : '(applied)'} Report`);
    const removed = Array.isArray(resp.removed) ? resp.removed : [];
    const failing = resp.failing_by_group || {};
    const totalFailing = Object.values(failing).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0);
    lines.push(`Failing detected: ${totalFailing}`);
    lines.push('');
    if (totalFailing > 0) {
      lines.push('## Failing feeds by group');
      Object.keys(failing).forEach(g => {
        const arr = failing[g] || [];
        if (arr.length) {
          lines.push(`- ${g}:`);
          arr.forEach(u => lines.push(`  - ${u}`));
        }
      });
      lines.push('');
    }
    if (!isDryRun) {
      lines.push(`Removed (${removed.length}):`);
      removed.forEach(r => lines.push(`- (${r.group}) ${r.url}`));
      lines.push('');
      lines.push('feeds.json updated and in-memory groups reloaded.');
    } else {
      lines.push('No changes written. This is a preview of what would be removed.');
    }
    return lines.join('\n');
  } catch (e) {
    return 'Could not build prune report.';
  }
}

async function doPruneFeeds() {
  try {
    setStatus('Pruning (dry run)...');
    const group = document.getElementById('feedGroup').value;
    // Step 1: dry run
    const preview = await api('/api/prune-feeds', { group, test_scrape: true, sample: 1, dry_run: true });
    const previewReport = buildPruneReport(preview, true);
    document.getElementById('output').value = previewReport;
    const totalFailing = Object.values(preview.failing_by_group || {}).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0);
    setStatus(`Dry run complete. ${totalFailing} failing feed(s) detected.`);
    if (totalFailing === 0) return;

    // Step 2: confirm apply
    const ok = window.confirm(`Remove ${totalFailing} failing feed(s) from ${group}? This will update feeds.json.`);
    if (!ok) return;

    setStatus('Applying prune...');
    const applied = await api('/api/prune-feeds', { group, test_scrape: true, sample: 1, dry_run: false });
    const appliedReport = buildPruneReport(applied, false);
    document.getElementById('output').value = appliedReport;
    setStatus(`Prune applied. Removed ${applied.removed_count} feed(s).`);
    // Reload groups in UI after prune
    await loadFeedGroups();
  } catch (e) {
    setStatus('Error pruning feeds');
    console.error(e);
  }
}

const btnPruneEl = document.getElementById('btnPrune');
if (btnPruneEl) btnPruneEl.addEventListener('click', doPruneFeeds);

// Refresh installed models from Ollama
document.getElementById('btnRefreshModels').addEventListener('click', async () => {
  setStatus('Refreshing models...');
  await loadModels();
  setStatus('Models refreshed.');
});

document.getElementById('btnFetch').addEventListener('click', async () => {
  try {
    setStatus('Fetching headlines...');
    const group = document.getElementById('feedGroup').value;
    const data = await api('/api/fetch-headlines', { group });
    headlines = data.items || [];
    renderHeadlines(headlines);
    setStatus(`Fetched ${headlines.length} items.`);
  } catch (e) {
    setStatus('Error fetching headlines');
    console.error(e);
  }
});

function buildValidationReport(resp) {
  try {
    const lines = [];
    lines.push(`# Feed Validation Report`);
    lines.push(`Total checked: ${resp.total} | OK: ${resp.ok} | Test scrape: ${resp.test_scrape ? 'on' : 'off'}`);
    lines.push('');
    const results = Array.isArray(resp.results) ? resp.results : [];
    const bad = results.filter(r => !(r.feed_ok && (!resp.test_scrape || r.scrape_ok === true)));
    const good = results.filter(r => r.feed_ok && (!resp.test_scrape || r.scrape_ok === true));
    if (good.length) {
      lines.push(`## OK feeds (${good.length})`);
      good.forEach(r => {
        lines.push(`- [OK] (${r.group}) ${r.url}`);
      });
      lines.push('');
    }
    if (bad.length) {
      lines.push(`## Problem feeds (${bad.length})`);
      bad.forEach(r => {
        const reasons = [];
        if (!r.feed_ok) {
          if (r.http_status && (r.http_status < 200 || r.http_status >= 400)) reasons.push(`HTTP ${r.http_status}`);
          if (r.entries === 0) reasons.push('no entries');
          if (Array.isArray(r.errors) && r.errors.length) reasons.push(...r.errors);
        }
        if (resp.test_scrape && r.scrape_ok === false) reasons.push('scrape failed/empty');
        const reasonText = reasons.length ? ` => ${reasons.join(', ')}` : '';
        lines.push(`- [FAIL] (${r.group}) ${r.url}${reasonText}`);
      });
    }
    lines.push('');
    lines.push('Tip: Remove failing feeds from news_assistant/backend/feeds.json or ask to add an auto-prune option.');
    return lines.join('\n');
  } catch (e) {
    return 'Could not build report.';
  }
}

async function doValidateFeeds() {
  try {
    setStatus('Validating feeds...');
    const group = document.getElementById('feedGroup').value;
    const body = { group, test_scrape: true, sample: 1 };
    const resp = await api('/api/validate-feeds', body);
    const report = buildValidationReport(resp);
    document.getElementById('output').value = report;
    const badCount = (resp.results || []).filter(r => !(r.feed_ok && (!resp.test_scrape || r.scrape_ok === true))).length;
    setStatus(`Validation done. ${resp.ok}/${resp.total} OK, ${badCount} problem(s).`);
  } catch (e) {
    setStatus('Error validating feeds');
    console.error(e);
  }
}

const btnValidateEl = document.getElementById('btnValidate');
if (btnValidateEl) btnValidateEl.addEventListener('click', doValidateFeeds);

document.getElementById('btnSummarize').addEventListener('click', async () => {
  try {
    const query = document.getElementById('query').value || '';
    const model = getSelectedModel();
    const expandAI = !!(document.getElementById('expandAI') && document.getElementById('expandAI').checked);
    const regions = detectRegionsFromContext(query);
    const queryForModel = buildQueryWithRegionHint(query, regions);

    // Pre-filter headlines by query using robust matching
    const matches = searchHeadlines(query, headlines, 200);
    let toSummarize = headlines;
    let allowedIdxs = null;
    if (!expandAI) {
      if (matches.length > 0) {
        const idxs = matches.map(m => m.index);
        allowedIdxs = idxs; // constrain auto-selection to lexical matches
        selectByIndices(idxs);
        // Move selected matches to the top for quick review/unselect
        reorderHeadlinesBySelection();
        toSummarize = idxs.map(i => headlines[i]);
        setStatus(`Found ${toSummarize.length} match(es). Summarizing them...`);
      } else {
        setStatus('No direct matches found. Summarizing all fetched headlines...');
      }
    } else {
      // Expand mode: evaluate all headlines with AI; don't constrain selection set
      clearAllSelections();
      if (matches.length > 0) {
        setStatus(`Found ${matches.length} lexical match(es). Expanding with AI across all headlines...`);
      } else {
        setStatus('Expanding with AI across all headlines...');
      }
      // Suppress obviously cross-region items before sending to model (heuristic)
      const qpartsForEx = expandQueryWithDomain(parseQueryParts(query), query);
      if (Array.isArray(qpartsForEx.excludeTokens) && qpartsForEx.excludeTokens.length) {
        toSummarize = headlines.filter(item => {
          const toks = tokensFromText(`${item.title || ''} ${item.summary || ''}`);
          for (const ex of qpartsForEx.excludeTokens) {
            if (tokensContainStem(toks, String(ex).toLowerCase())) return false;
          }
          return true;
        });
      }
    }

    const out = await api('/api/summarize', { query: queryForModel, headlines: toSummarize, model });
    document.getElementById('output').value = out.summary || '';

    // Refine selection via precise structured mentions; fallback to heuristic
    let count = 0;
    if (Array.isArray(out.mentions) && out.mentions.length) {
      // If we have mentions, reset selection and select strictly within allowed set (if any)
      clearAllSelections();
      count = autoSelectByMentions(out.mentions, allowedIdxs);
    }
    if (count === 0) {
      // Keep existing pre-filtered selection, but add any within allowed that match the summary strongly
      count = autoSelectFromSummary(out.summary || '', allowedIdxs);
    }
    // Reorder list to show selections at the top
    reorderHeadlinesBySelection();
    const totalSelected = document.querySelectorAll('#headlines input[type=checkbox]:checked').length;
    if (count > 0) setStatus(`Done. Auto-selected ${count}. Selected total: ${totalSelected}.`);
    else setStatus(`Done. Selected total: ${totalSelected}.`);
  } catch (e) {
    setStatus('Error summarizing');
    console.error(e);
  }
});

document.getElementById('btnScrape').addEventListener('click', async () => {
  try {
    setStatus('Scraping selected articles...');
    const urls = getSelectedHeadlineUrls();
    const out = await api('/api/scrape', { urls });
    scraped = out.articles || [];
    document.getElementById('output').value = scraped.map(a => `# ${a.title}\n\n${a.content}`).join('\n\n---\n\n');
    setStatus(`Scraped ${scraped.length} articles.`);
  } catch (e) {
    setStatus('Error scraping');
    console.error(e);
  }
});

document.getElementById('btnScanVideos').addEventListener('click', async () => {
  try {
    setStatus('Scanning for videos...');
    let urls = getSelectedHeadlineUrls();
    if (!urls.length) {
      // If none selected, scan all fetched headlines
      urls = (headlines || []).map(h => h.link).filter(Boolean);
    }
    if (!urls.length) {
      setStatus('No headlines to scan.');
      return;
    }
    const out = await api('/api/find-videos', { urls });
    videos = Array.isArray(out.videos) ? out.videos : [];
    renderVideos(applyVideoFilters(videos));
    setStatus(`Found ${videos.length} video source(s). Click a video to play.`);
  } catch (e) {
    setStatus('Error scanning videos');
    console.error(e);
  }
});

document.getElementById('btnGenerate').addEventListener('click', async () => {
  try {
    setStatus('Generating article...');
    const query = document.getElementById('query').value || '';
    const model = getSelectedModel();
    const out = await api('/api/generate', { query, articles: scraped, tone: 'neutral', length: 'medium', model });
    document.getElementById('output').value = out.article || '';
    setStatus('Done.');
  } catch (e) {
    setStatus('Error generating');
    console.error(e);
  }
});

document.getElementById('btnTTS').addEventListener('click', async () => {
  try {
    const text = document.getElementById('output').value || '';
    if (!text) return;
    setStatus('Speaking...');
    await api('/api/tts', { text });
    setStatus('Speaking (you can continue using the app).');
  } catch (e) {
    setStatus('Error with TTS');
    console.error(e);
  }
});

document.getElementById('btnPDF').addEventListener('click', async () => {
  try {
    const text = document.getElementById('output').value || '';
    if (!text) return;
    setStatus('Exporting to PDF...');
    const out = await api('/api/pdf', { text, title: 'Generated Article' });
    if (out.path) {
      const a = document.createElement('a');
      a.href = out.path; a.download = '';
      a.click();
    }
    setStatus('PDF saved.');
  } catch (e) {
    setStatus('Error exporting PDF');
    console.error(e);
  }
});

// Dropdown items next to Fetch Headlines
const ddValidate = document.getElementById('ddValidate');
if (ddValidate) {
  ddValidate.addEventListener('click', (e) => {
    e.preventDefault();
    doValidateFeeds();
  });
}
const ddPrune = document.getElementById('ddPrune');
if (ddPrune) {
  ddPrune.addEventListener('click', (e) => {
    e.preventDefault();
    doPruneFeeds();
  });
}

init().catch(console.error);

// Reorder interactively when user manually toggles checkboxes
document.getElementById('headlines').addEventListener('change', (e) => {
  if (e && e.target && e.target.matches('input[type=checkbox]')) {
    reorderHeadlinesBySelection();
  }
});
