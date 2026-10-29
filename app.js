'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const DAILY_QUOTA = 10000;
const $ = (s, root = document) => root.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 저장소 · 키 · 할당량 ---------------- */

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch { return null; }
}

let memKey = '';
const getKey = () => memKey || store('yt_api_key') || '';

// YouTube 할당량은 태평양 시간 자정에 초기화된다
const ptDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
function quotaUsed() {
  try {
    const q = JSON.parse(store('yt_quota') || '{}');
    return q.date === ptDate() ? q.used : 0;
  } catch { return 0; }
}
function addQuota(n) {
  store('yt_quota', JSON.stringify({ date: ptDate(), used: quotaUsed() + n }));
  renderStatus();
}

function renderStatus() {
  const ks = $('#keyStatus');
  if (getKey()) { ks.textContent = 'API 키 연결됨'; ks.className = 'pill ok'; }
  else { ks.textContent = 'API 키 없음'; ks.className = 'pill warn'; }
  const used = quotaUsed();
  const q = $('#quota');
  q.textContent = `오늘 약 ${used.toLocaleString()} / ${DAILY_QUOTA.toLocaleString()}`;
  q.className = 'pill' + (used > DAILY_QUOTA * 0.8 ? ' warn' : '');
}

/* ---------------- API 호출 ---------------- */

const COST = { search: 100 };

function explainError(status, err) {
  const reason = err?.errors?.[0]?.reason || err?.details?.[0]?.reason || '';
  const msg = err?.message || '';
  if (/API key not valid|API_KEY_INVALID|keyInvalid/i.test(reason + msg)) return 'API 키가 올바르지 않습니다. 설정 탭에서 키를 확인해 주세요.';
  if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) return '오늘의 API 할당량을 모두 사용했습니다. 태평양 시간 자정(한국 시간 오후 4~5시)에 초기화됩니다.';
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason + msg)) return 'Google Cloud 프로젝트에서 YouTube Data API v3가 사용 설정되지 않았습니다.';
  if (/ipRefererBlocked|API_KEY_HTTP_REFERRER_BLOCKED|referer/i.test(reason + msg)) return 'API 키의 웹사이트 제한 때문에 차단되었습니다. 키 제한에 이 사이트 주소를 추가해 주세요.';
  if (/commentsDisabled/i.test(reason)) return '이 영상은 댓글이 사용 중지되어 있습니다.';
  if (/videoNotFound/i.test(reason)) return '영상을 찾을 수 없습니다.';
  if (/playlistNotFound/i.test(reason)) return '업로드 목록을 찾을 수 없습니다.';
  return `API 오류 (${status}${reason ? ' · ' + reason : ''}) ${msg}`;
}

class ApiError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

async function yt(endpoint, params) {
  const key = getKey();
  if (!key) throw new ApiError('먼저 “API 키 설정” 탭에서 API 키를 입력해 주세요.', 'noKey');
  const url = new URL(API + endpoint);
  for (const [k, v] of Object.entries({ ...params, key })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  let res;
  try { res = await fetch(url); }
  catch { throw new ApiError('네트워크 오류로 YouTube API에 연결하지 못했습니다.', 'network'); }
  addQuota(COST[endpoint] || 1);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(explainError(res.status, data.error), data.error?.errors?.[0]?.reason);
  }
  return data;
}

// 할당량이 도중에 떨어지면 그때까지 받은 결과는 살려서 보여주고 안내한다
const QUOTA_RESET = '태평양 시간 자정(한국 시간 오후 4~5시)에 초기화됩니다.';
const isQuotaError = e => /quotaExceeded|dailyLimitExceeded/i.test(e?.reason || '');
const quotaNotice = (sel, what) => setStatus(sel, `할당량이 소진되어 ${what} ${QUOTA_RESET}`, 'error');

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const unique = arr => [...new Set(arr)];

/* ---------------- 입력 파싱 ---------------- */

function parseVideoId(s) {
  s = s.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/|\/v\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function parseChannel(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/(UC[\w-]{22})/))) return { id: m[1] };
  if ((m = s.match(/@([^\/?#\s]+)/))) return { handle: '@' + safeDecode(m[1]) };
  if ((m = s.match(/\/user\/([^\/?#\s]+)/))) return { username: safeDecode(m[1]) };
  if ((m = s.match(/\/c\/([^\/?#\s]+)/))) return { query: safeDecode(m[1]) };
  return { query: s };
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/* ---------------- 데이터 정규화 ---------------- */

function parseDuration(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const numOrNull = v => (v === undefined || v === null ? null : Number(v));

function normVideo(v) {
  const s = v.statistics || {}, sn = v.snippet || {}, cd = v.contentDetails || {}, pl = v.player || {};
  const secs = parseDuration(cd.duration);
  const published = new Date(sn.publishedAt);
  const ageDays = Math.max(1, (Date.now() - published) / 864e5);
  const views = Number(s.viewCount || 0);
  const likes = numOrNull(s.likeCount);
  const comments = numOrNull(s.commentCount);
  const hashShorts = /#shorts?\b/i.test(`${sn.title || ''} ${sn.description || ''}`);
  const out = {
    id: v.id,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    title: sn.title || '',
    description: sn.description || '',
    channelId: sn.channelId,
    channelTitle: sn.channelTitle || '',
    publishedAt: published,
    thumb: sn.thumbnails?.default?.url || '',
    thumbs: sn.thumbnails || {},
    tags: (sn.tags || []).join(', '),
    categoryId: sn.categoryId,
    live: sn.liveBroadcastContent || 'none',
    duration: secs,
    isLive: cd.duration === 'P0D',
    hashShorts,
    embedW: Number(pl.embedWidth) || null,
    embedH: Number(pl.embedHeight) || null,
    views, likes, comments,
    likeRate: views && likes != null ? likes / views : null,
    commentRate: views && comments != null ? comments / views : null,
    er: views ? ((likes || 0) + (comments || 0)) / views : null,
    viewsPerDay: views / ageDays,
    ageDays: Math.floor(ageDays),
  };
  Object.assign(out, classifyShort(out));
  out.format = out.isLive ? '라이브' : out.isShort ? '쇼츠' : '일반 영상';
  return out;
}

function normChannel(c) {
  const s = c.statistics || {}, sn = c.snippet || {};
  const subs = s.hiddenSubscriberCount ? null : numOrNull(s.subscriberCount);
  const totalViews = Number(s.viewCount || 0);
  const videoCount = Number(s.videoCount || 0);
  return {
    id: c.id,
    url: `https://www.youtube.com/channel/${c.id}`,
    title: sn.title || '',
    handle: sn.customUrl || '',
    thumb: sn.thumbnails?.default?.url || '',
    country: sn.country || '',
    createdAt: sn.publishedAt ? new Date(sn.publishedAt) : null,
    description: sn.description || '',
    uploads: c.contentDetails?.relatedPlaylists?.uploads,
    subs, totalViews, videoCount,
    lifetimeAvgViews: videoCount ? totalViews / videoCount : null,
  };
}

/* ---------------- 데이터 가져오기 ---------------- */

async function fetchVideos(ids) {
  const out = [];
  for (const part of chunk(unique(ids), 50)) {
    // maxWidth를 주면 player.embedWidth/Height가 영상 화면비대로 내려온다 (쇼츠 판별용)
    const d = await yt('videos', { part: 'snippet,statistics,contentDetails,player', id: part.join(','), maxWidth: 1000 });
    out.push(...d.items.map(normVideo));
  }
  const byId = new Map(out.map(v => [v.id, v]));
  return unique(ids).map(id => byId.get(id)).filter(Boolean);
}

/* ---------------- 쇼츠 판별 ----------------
 * Data API는 쇼츠 여부를 직접 알려주지 않는다. YouTube 기준 쇼츠는 "세로 또는 정사각형 + 3분 이하"
 * (2024-10-15 이전 업로드는 60초 이하)이므로, part=player의 embedWidth/Height로 화면비를 확인해 판별한다.
 * 화면비 정보가 없으면 길이와 #shorts 표기로 추정한다.
 */
const SHORTS_3MIN_SINCE = new Date('2024-10-15');
const SHORTS_LAUNCH = new Date('2020-09-14');

function classifyShort(v) {
  if (v.isLive) return { isShort: false, shortCheck: '' };
  const maxSecs = v.publishedAt >= SHORTS_3MIN_SINCE ? 180 : 60;
  if (v.duration > maxSecs) return { isShort: false, shortCheck: '길이 확인' };
  if (v.embedW && v.embedH) {
    const vertical = v.embedH >= v.embedW;
    const isShort = vertical && v.duration > 0 && v.duration <= maxSecs && v.publishedAt >= SHORTS_LAUNCH;
    return { isShort, shortCheck: '화면비 확인' };
  }
  return { isShort: v.duration > 0 && (v.duration <= 60 || (v.duration <= 180 && v.hashShorts)), shortCheck: '추정' };
}

async function fetchChannels(ids) {
  const out = [];
  for (const part of chunk(unique(ids), 50)) {
    const d = await yt('channels', { part: 'snippet,statistics,contentDetails', id: part.join(',') });
    out.push(...(d.items || []).map(normChannel));
  }
  const byId = new Map(out.map(c => [c.id, c]));
  return unique(ids).map(id => byId.get(id)).filter(Boolean);
}

async function resolveChannelId(input) {
  const p = parseChannel(input);
  if (p.id) return p.id;
  if (p.handle || p.username) {
    const d = await yt('channels', { part: 'id', forHandle: p.handle, forUsername: p.username });
    if (d.items?.length) return d.items[0].id;
    if (!p.handle) return null;
    p.query = p.handle;
  }
  const d = await yt('search', { part: 'snippet', type: 'channel', q: p.query, maxResults: 1 });
  return d.items?.[0]?.snippet?.channelId || d.items?.[0]?.id?.channelId || null;
}

async function fetchRecentVideos(playlistId, n, type, onProgress) {
  const out = [];
  let pageToken, scanned = 0;
  do {
    let pl;
    try {
      pl = await yt('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken });
    } catch (e) {
      if (e.reason === 'playlistNotFound') break; // 업로드 영상이 없는 채널
      throw e;
    }
    pageToken = pl.nextPageToken;
    const ids = pl.items.map(i => i.contentDetails.videoId);
    scanned += ids.length;
    for (const v of await fetchVideos(ids)) {
      if (v.live !== 'none') continue; // 예정/진행 중 라이브 제외
      if (type === 'long' && v.isShort) continue;
      if (type === 'short' && !v.isShort) continue;
      out.push(v);
      if (out.length >= n) break;
    }
    onProgress?.(out.length);
  } while (out.length < n && pageToken && scanned < 500);
  return out.sort((a, b) => b.publishedAt - a.publishedAt);
}

/* ---------------- 지표 계산 ---------------- */

const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => (a.length ? sum(a) / a.length : null);
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
}

function channelMetrics(ch, vids) {
  const views = vids.map(v => v.views);
  const likes = vids.map(v => v.likes || 0);
  const comments = vids.map(v => v.comments || 0);
  const totalV = sum(views);
  const avgViews = mean(views);
  const med = median(views);
  const oldest = vids.length ? Math.min(...vids.map(v => v.publishedAt)) : null;
  const spanWeeks = oldest ? Math.max(1, (Date.now() - oldest) / (7 * 864e5)) : null;
  return {
    ...ch,
    videos: vids,
    sample: vids.length,
    avgViews,
    medianViews: med,
    maxViews: views.length ? Math.max(...views) : null,
    avgLikes: mean(likes),
    avgComments: mean(comments),
    er: totalV ? (sum(likes) + sum(comments)) / totalV : null,
    likeRate: totalV ? sum(likes) / totalV : null,
    commentRate: totalV ? sum(comments) / totalV : null,
    reach: ch.subs && avgViews != null ? avgViews / ch.subs : null,
    medianReach: ch.subs && med != null ? med / ch.subs : null,
    cv: avgViews ? stdev(views) / avgViews : null,
    hits: med != null ? views.filter(v => v >= med * 2).length : null,
    perWeek: spanWeeks ? vids.length / spanWeeks : null,
    shortsRatio: vids.length ? vids.filter(v => v.isShort).length / vids.length : null,
    avgViewsPerDay: mean(vids.map(v => v.viewsPerDay)),
    avgDuration: mean(vids.map(v => v.duration)),
    lastUpload: vids.length ? new Date(Math.max(...vids.map(v => v.publishedAt))) : null,
  };
}

/* ---------------- 포맷 ---------------- */

const fmt = {
  num: v => (v == null || isNaN(v) ? '-' : Math.round(v).toLocaleString('ko-KR')),
  dec: v => (v == null || isNaN(v) ? '-' : v.toLocaleString('ko-KR', { maximumFractionDigits: 1 })),
  pct: v => (v == null || isNaN(v) ? '-' : (v * 100).toFixed(2) + '%'),
  date: v => (v ? new Date(v).toLocaleDateString('sv-SE') : '-'),
  dur: s => {
    if (!s) return '-';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  },
  compact: v => {
    if (v == null || isNaN(v)) return '-';
    const a = Math.abs(v);
    const t = x => (x >= 100 ? x.toFixed(0) : x.toFixed(1)).replace(/\.0$/, '');
    if (a >= 1e8) return t(v / 1e8) + '억';
    if (a >= 1e4) return t(v / 1e4) + '만';
    if (a >= 1e3) return t(v / 1e3) + '천';
    return String(Math.round(v));
  },
};

// CSV에는 서식 없는 원값을 넣는다
const csvVal = {
  num: v => (v == null || isNaN(v) ? '' : Math.round(v)),
  dec: v => (v == null || isNaN(v) ? '' : Math.round(v * 100) / 100),
  pct: v => (v == null || isNaN(v) ? '' : (v * 100).toFixed(3)),
  date: v => (v ? new Date(v).toLocaleDateString('sv-SE') : ''),
  dur: v => v || '',
  text: v => v ?? '',
};

/* ---------------- 테이블 · CSV ---------------- */

// cols: { key, label, type: 'num'|'dec'|'pct'|'date'|'dur'|'text', html?(row), get?(row) }
function renderTable(el, cols, rows, { sortKey = null, dir = -1, onRowClick, rowClass } = {}) {
  const get = (c, r) => (c.get ? c.get(r) : r[c.key]);
  const indexed = rows.map((r, i) => [r, i]);
  const draw = () => {
    let list = indexed;
    if (sortKey) {
      const c = cols.find(x => x.key === sortKey);
      list = [...indexed].sort(([a], [b]) => {
        const x = get(c, a), y = get(c, b);
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        return (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y) * dir;
      });
    }
    const head = cols.map(c => {
      const isNum = c.type && c.type !== 'text';
      const arrow = sortKey === c.key ? (dir > 0 ? ' ▲' : ' ▼') : '';
      if (c.sortable === false) return `<th class="${c.cls || ''}">${esc(c.label)}</th>`;
      return `<th data-k="${c.key}" class="${isNum ? 'num' : ''} ${c.cls || ''} ${sortKey === c.key ? 'sorted' : ''}">${esc(c.label)}${arrow}</th>`;
    }).join('');
    const body = list.map(([r, i]) => {
      const cls = [onRowClick ? 'clickable' : '', rowClass?.(r) || ''].join(' ');
      const tds = cols.map(c => {
        const isNum = c.type && c.type !== 'text';
        const content = c.html ? c.html(r) : esc(fmt[c.type]?.(get(c, r)) ?? get(c, r));
        return `<td class="${isNum ? 'num' : ''} ${c.cls || ''}">${content}</td>`;
      }).join('');
      return `<tr data-i="${i}" class="${cls}">${tds}</tr>`;
    }).join('');
    el.innerHTML = `<div class="tablewrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  el.onclick = e => {
    const th = e.target.closest('th[data-k]');
    if (th) {
      const k = th.dataset.k;
      if (sortKey === k) dir = -dir; else { sortKey = k; dir = cols.find(c => c.key === k).type === 'text' ? 1 : -1; }
      draw();
      return;
    }
    const tr = e.target.closest('tr[data-i]');
    if (tr && onRowClick && !e.target.closest('a, button')) onRowClick(rows[+tr.dataset.i], tr);
  };
  draw();
  return { sortState: () => ({ sortKey, dir }) };
}

function downloadCSV(filename, cols, rows) {
  const cell = v => {
    if (v == null) return '';
    let s = String(v);
    // 엑셀 수식 주입 방지
    // (@핸들 같은 작성자명은 그대로 두고, 함수처럼 보이는 @만 막는다)
    if (typeof v === 'string' && (/^[=+\-\t\r]/.test(s) || /^@.*\(/.test(s))) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.map(c => cell(c.type === 'pct' ? `${c.label}(%)` : c.label));
  const lines = rows.map(r => cols.map(c => {
    const raw = c.csv ? c.csv(r) : (c.get ? c.get(r) : r[c.key]);
    return cell(c.csv ? raw : (csvVal[c.type || 'text'] || csvVal.text)(raw));
  }).join(','));
  // BOM을 붙여 엑셀에서 한글이 깨지지 않게 한다
  const blob = new Blob(['﻿' + [header.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}_${new Date().toLocaleDateString('sv-SE')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function block(el, { title, sub = '', actions = [] }) {
  el.innerHTML = `
    <div class="card">
      <div class="block-head">
        <div><h3>${esc(title)}</h3>${sub ? `<p class="muted">${sub}</p>` : ''}</div>
        <div class="block-actions">${actions.map((a, i) => `<button class="ghost small" data-a="${i}">${esc(a.label)}</button>`).join('')}</div>
      </div>
      <div class="block-body"></div>
    </div>`;
  el.querySelectorAll('[data-a]').forEach(b => { b.onclick = () => actions[+b.dataset.a].run(); });
  return $('.block-body', el);
}

const statCards = items => `<div class="stats">${items.map(([label, value, sub]) => `
  <div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`).join('')}</div>`;

/* ---------------- 공통 컬럼 ---------------- */

const titleCol = { key: 'title', label: '제목', type: 'text', cls: 'title', html: r => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` };
const channelCol = { key: 'title', label: '채널', type: 'text', html: r => `<div class="chcell">${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : ''}<div><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="muted">${esc(r.handle)}</div></div></div>` };
const formatCol = { key: 'format', label: '형식', type: 'text', html: r => `<span class="tag ${r.isShort ? 'short' : ''}" title="${r.shortCheck === '추정' ? '길이·#shorts 기준 추정' : ''}">${esc(r.format)}${r.shortCheck === '추정' ? '*' : ''}</span>` };

const videoCols = (withChannel) => [
  titleCol,
  ...(withChannel ? [{ key: 'channelTitle', label: '채널', type: 'text' }, { key: 'subs', label: '구독자', type: 'num' }] : []),
  { key: 'publishedAt', label: '게시일', type: 'date' },
  formatCol,
  { key: 'duration', label: '길이', type: 'dur' },
  { key: 'views', label: '조회수', type: 'num' },
  { key: 'likes', label: '좋아요', type: 'num' },
  { key: 'comments', label: '댓글', type: 'num' },
  { key: 'er', label: '참여율', type: 'pct' },
  { key: 'likeRate', label: '좋아요율', type: 'pct' },
  { key: 'viewsPerDay', label: '일평균 조회수', type: 'num' },
  ...(withChannel ? [{ key: 'reach', label: '구독자 대비 조회율', type: 'pct' }] : []),
];
const videoCsvExtra = [
  { key: 'id', label: '영상ID', type: 'text' },
  { key: 'url', label: 'URL', type: 'text' },
  { key: 'commentRate', label: '댓글율', type: 'pct' },
  { key: 'shortCheck', label: '형식 판별', type: 'text' },
  { key: 'ageDays', label: '게시 후 일수', type: 'num' },
  { key: 'tags', label: '태그', type: 'text' },
];

/* ---------------- 진행 상태 ---------------- */

function setStatus(sel, msg, kind = '') {
  const el = $(sel);
  el.className = 'status-line ' + kind;
  el.innerHTML = kind === 'busy' ? `<span class="spinner"></span>${esc(msg)}` : esc(msg);
}

async function run(btn, statusSel, fn) {
  btn.disabled = true;
  const before = quotaUsed();
  try {
    await fn();
    const used = quotaUsed() - before;
    if ($(statusSel).classList.contains('busy')) setStatus(statusSel, `완료 · 할당량 ${used.toLocaleString()} 사용`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus(statusSel, e.message || String(e), 'error');
    if (e.reason === 'noKey') openKeyModal();
  } finally {
    btn.disabled = false;
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------------- 차트 ---------------- */

function viewsChart(vids) {
  const data = [...vids].sort((a, b) => a.publishedAt - b.publishedAt);
  if (!data.length) return '';
  const W = 900, H = 240, L = 54, R = 10, T = 12, B = 26;
  const max = Math.max(...data.map(v => v.views), 1);
  const bw = (W - L - R) / data.length;
  const y = v => T + (H - T - B) * (1 - v / max);
  const avg = mean(data.map(v => v.views)), med = median(data.map(v => v.views));
  // 쇼츠는 색을 하나 더 쓰는 대신 빗금으로 구분한다
  let svg = `<defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="5" class="hatch-line"/></pattern></defs>`;
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4, yy = y(v);
    svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="axis" x="${L - 6}" y="${yy + 4}" text-anchor="end">${fmt.compact(v)}</text>`;
  }
  data.forEach((v, i) => {
    const x = L + i * bw + bw * 0.15, yy = y(v.views);
    svg += `<rect class="bar ${v.isShort ? 'short' : ''}" x="${x}" y="${yy}" width="${Math.max(1, bw * 0.7)}" height="${H - B - yy}"><title>${esc(v.title)}\n${fmt.date(v.publishedAt)} · 조회수 ${fmt.num(v.views)} · 참여율 ${fmt.pct(v.er)}</title></rect>`;
  });
  svg += `<line class="avg" x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}"/>`;
  svg += `<line class="med" x1="${L}" x2="${W - R}" y1="${y(med)}" y2="${y(med)}"/>`;
  svg += `<text class="axis" x="${L}" y="${H - 6}">${fmt.date(data[0].publishedAt)}</text>`;
  svg += `<text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${fmt.date(data[data.length - 1].publishedAt)}</text>`;
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="영상별 조회수">${svg}</svg>
    <div class="legend"><span><i class="sw long"></i>일반 영상</span><span><i class="sw short"></i>쇼츠</span>
    <span><i class="ln avg"></i>평균 ${fmt.compact(avg)}</span><span><i class="ln med"></i>중앙값 ${fmt.compact(med)}</span>
    <span>막대에 마우스를 올리면 영상 정보가 보입니다</span></div></div>`;
}

/* ---------------- 탭: 채널 분석 ---------------- */

let channelResults = [];

const channelCols = [
  channelCol,
  { key: 'subs', label: '구독자', type: 'num' },
  { key: 'totalViews', label: '총 조회수', type: 'num' },
  { key: 'videoCount', label: '총 영상', type: 'num' },
  { key: 'sample', label: '분석 영상', type: 'num' },
  { key: 'avgViews', label: '평균 조회수', type: 'num' },
  { key: 'medianViews', label: '중앙값 조회수', type: 'num' },
  { key: 'avgLikes', label: '평균 좋아요', type: 'num' },
  { key: 'avgComments', label: '평균 댓글', type: 'num' },
  { key: 'er', label: '참여율', type: 'pct' },
  { key: 'reach', label: '구독자 대비 조회율', type: 'pct' },
  { key: 'perWeek', label: '주간 업로드', type: 'dec' },
  { key: 'shortsRatio', label: '쇼츠 비중', type: 'pct' },
  { key: 'lastUpload', label: '최근 업로드', type: 'date' },
];
const channelCsvCols = [
  { key: 'title', label: '채널명', type: 'text' },
  { key: 'handle', label: '핸들', type: 'text' },
  { key: 'id', label: '채널ID', type: 'text' },
  { key: 'url', label: 'URL', type: 'text' },
  { key: 'country', label: '국가', type: 'text' },
  { key: 'createdAt', label: '개설일', type: 'date' },
  ...channelCols.slice(1),
  { key: 'maxViews', label: '최고 조회수', type: 'num' },
  { key: 'medianReach', label: '구독자 대비 조회율(중앙값)', type: 'pct' },
  { key: 'likeRate', label: '좋아요율', type: 'pct' },
  { key: 'commentRate', label: '댓글율', type: 'pct' },
  { key: 'cv', label: '조회수 편차(CV)', type: 'dec', csv: r => (r.cv == null ? '' : r.cv.toFixed(3)) },
  { key: 'hits', label: '히트 영상 수', type: 'num' },
  { key: 'avgViewsPerDay', label: '영상당 일평균 조회수', type: 'num' },
  { key: 'avgDuration', label: '평균 길이(초)', type: 'num' },
  { key: 'lifetimeAvgViews', label: '누적 영상당 평균 조회수', type: 'num' },
];

async function runChannels() {
  const lines = unique($('#chInput').value.split('\n').map(s => s.trim()).filter(Boolean));
  if (!lines.length) return toast('분석할 채널을 입력해 주세요.');
  const n = +$('#chN').value, type = $('#chType').value;

  const ids = [], failed = [], results = [];
  let quotaHit = false;
  try {
    for (const [i, line] of lines.entries()) {
      setStatus('#chStatus', `채널 확인 중… (${i + 1}/${lines.length}) ${line}`, 'busy');
      const id = await resolveChannelId(line);
      if (id) ids.push(id); else failed.push(line);
    }
    if (!ids.length) throw new Error('채널을 찾지 못했습니다: ' + failed.join(', '));

    const channels = await fetchChannels(ids);
    for (const [i, ch] of channels.entries()) {
      const label = `${ch.title} 영상 불러오는 중… (${i + 1}/${channels.length})`;
      setStatus('#chStatus', label, 'busy');
      const vids = ch.uploads ? await fetchRecentVideos(ch.uploads, n, type, k => setStatus('#chStatus', `${label} ${k}개`, 'busy')) : [];
      results.push(channelMetrics(ch, vids));
    }
  } catch (e) {
    // 도중에 끊긴 채널은 영상이 일부만 모여 지표가 왜곡되므로 넣지 않는다
    if (!isQuotaError(e) || !results.length) throw e;
    quotaHit = true;
  }
  channelResults = results;

  const typeLabel = { all: '전체', long: '일반', short: '쇼츠' }[type];
  const body = block($('#chResult'), {
    title: `채널 비교 (${results.length}개)`,
    sub: `최근 ${typeLabel} 영상 ${n}개 기준 · 열 제목을 누르면 정렬, 행을 누르면 영상별 상세${failed.length ? ` · 찾지 못한 채널: ${esc(failed.join(', '))}` : ''}`,
    actions: [
      { label: '채널 요약 CSV', run: () => downloadCSV('채널비교', channelCsvCols, channelResults) },
      { label: '전체 영상 CSV', run: () => downloadCSV('채널별_영상', [{ key: 'channelTitle', label: '채널', type: 'text' }, ...videoCols(false), ...videoCsvExtra], channelResults.flatMap(c => c.videos)) },
    ],
  });
  renderTable(body, channelCols, results, {
    onRowClick: (r, tr) => {
      tr.parentElement.querySelectorAll('tr.selected').forEach(x => x.classList.remove('selected'));
      tr.classList.add('selected');
      showChannelDetail(r);
    },
  });
  $('#chDetail').innerHTML = '';
  if (results.length === 1) showChannelDetail(results[0]);
  if (quotaHit) quotaNotice('#chStatus', `채널 ${lines.length}개 중 ${results.length}개까지만 분석했습니다.`);
}

function showChannelDetail(c) {
  const body = block($('#chDetail'), {
    title: c.title,
    sub: `${esc(c.handle)} · 개설 ${fmt.date(c.createdAt)}${c.country ? ' · ' + esc(c.country) : ''} · 분석 영상 ${c.sample}개`,
    actions: [{ label: '이 채널 영상 CSV', run: () => downloadCSV(`${c.title}_영상`, [...videoCols(false), ...videoCsvExtra], c.videos) }],
  });
  body.innerHTML = statCards([
    ['구독자', fmt.compact(c.subs), c.subs == null ? '비공개' : fmt.num(c.subs)],
    ['평균 조회수', fmt.compact(c.avgViews), `중앙값 ${fmt.compact(c.medianViews)}`],
    ['구독자 대비 조회율', fmt.pct(c.reach), `중앙값 기준 ${fmt.pct(c.medianReach)}`],
    ['참여율', fmt.pct(c.er), `좋아요 ${fmt.pct(c.likeRate)} · 댓글 ${fmt.pct(c.commentRate)}`],
    ['평균 좋아요 / 댓글', `${fmt.compact(c.avgLikes)} / ${fmt.compact(c.avgComments)}`],
    ['주간 업로드', fmt.dec(c.perWeek) + '개', `최근 ${fmt.date(c.lastUpload)}`],
    ['히트 영상', `${c.hits ?? '-'}개`, '중앙값의 2배 이상'],
    ['조회수 편차(CV)', c.cv == null ? '-' : c.cv.toFixed(2), '낮을수록 성과가 안정적'],
    ['쇼츠 비중', fmt.pct(c.shortsRatio), `평균 길이 ${fmt.dur(Math.round(c.avgDuration || 0))}`],
    ['총 조회수', fmt.compact(c.totalViews), `영상 ${fmt.num(c.videoCount)}개`],
  ]) + viewsChart(c.videos) + '<div class="vtable"></div>';
  renderTable($('.vtable', body), videoCols(false), c.videos);
  $('#chDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- 탭: 영상별 비교 ---------------- */

let videoResults = [];

async function attachChannelStats(vids) {
  const chs = await fetchChannels(unique(vids.map(v => v.channelId)));
  const byId = new Map(chs.map(c => [c.id, c]));
  for (const v of vids) {
    v.subs = byId.get(v.channelId)?.subs ?? null;
    v.reach = v.subs ? v.views / v.subs : null;
  }
  return chs;
}

async function runVideos() {
  const lines = $('#vInput').value.split('\n').map(s => s.trim()).filter(Boolean);
  const ids = unique(lines.map(parseVideoId).filter(Boolean));
  const bad = lines.filter(l => !parseVideoId(l));
  if (!ids.length) return toast('영상 URL이나 ID를 입력해 주세요.');

  const vids = [];
  let checked = 0, quotaMsg = '';
  try {
    for (const part of chunk(ids, 50)) {
      setStatus('#vStatus', `영상 ${ids.length}개 조회 중… ${checked}개 완료`, 'busy');
      vids.push(...await fetchVideos(part));
      checked += part.length;
    }
  } catch (e) {
    if (!isQuotaError(e) || !vids.length) throw e;
    quotaMsg = `영상 ${ids.length}개 중 ${checked}개까지만 불러왔습니다. 구독자 수도 불러오지 못했습니다.`;
  }
  if (!quotaMsg) {
    setStatus('#vStatus', '채널 구독자 수 조회 중…', 'busy');
    try { await attachChannelStats(vids); }
    catch (e) {
      if (!isQuotaError(e)) throw e;
      quotaMsg = '영상 지표는 모두 불러왔지만 구독자 수는 불러오지 못했습니다.';
    }
  }
  videoResults = vids;

  const missing = checked - vids.length;
  const tv = sum(vids.map(v => v.views)), tl = sum(vids.map(v => v.likes || 0)), tc = sum(vids.map(v => v.comments || 0));
  const cols = videoCols(true);
  const body = block($('#vResult'), {
    title: `영상 ${vids.length}개`,
    sub: [missing ? `비공개·삭제 등으로 ${missing}개를 불러오지 못했습니다` : '', bad.length ? `인식하지 못한 줄 ${bad.length}개` : ''].filter(Boolean).join(' · '),
    actions: [{ label: 'CSV 다운로드', run: () => downloadCSV('영상분석', [...cols, ...videoCsvExtra], videoResults) }],
  });
  body.innerHTML = statCards([
    ['총 조회수', fmt.compact(tv), fmt.num(tv)],
    ['총 좋아요', fmt.compact(tl), fmt.num(tl)],
    ['총 댓글', fmt.compact(tc), fmt.num(tc)],
    ['평균 조회수', fmt.compact(mean(vids.map(v => v.views))), `중앙값 ${fmt.compact(median(vids.map(v => v.views)))}`],
    ['전체 참여율', fmt.pct(tv ? (tl + tc) / tv : null), '(좋아요+댓글) ÷ 조회수'],
    ['평균 구독자 대비 조회율', fmt.pct(mean(vids.filter(v => v.reach != null).map(v => v.reach)))],
  ]) + '<div class="vtable"></div>';
  renderTable($('.vtable', body), cols, vids);
  if (quotaMsg) quotaNotice('#vStatus', quotaMsg);
}

/* ---------------- 탭: 키워드 검색 ---------------- */

let searchResults = [];

// 결과 수 "직접 입력" 옆 ⓘ 버튼의 안내 창
function toggleCountInfo(open = $('#sCountPop').hidden) {
  $('#sCountPop').hidden = !open;
  $('#sCountInfo').setAttribute('aria-expanded', String(open));
}

// YouTube 검색은 한 검색어당 최대 500건 정도까지만 결과를 준다
const SEARCH_MAX = 500;
function searchCount() {
  if ($('#sCount').value !== 'custom') return +$('#sCount').value;
  const n = Math.round(+$('#sCountCustom').value);
  return n >= 1 ? Math.min(n, SEARCH_MAX) : 0;
}

function updateSearchCost() {
  $('#sCountCustomRow').hidden = $('#sCount').value !== 'custom';
  if ($('#sCountCustomRow').hidden) toggleCountInfo(false);
  const count = searchCount();
  const pages = Math.ceil(count / 50);
  const extra = Math.ceil(count / 50) * ($('#sType').value === 'video' ? 2 : 1);
  const typed = $('#sCount').value === 'custom' ? Math.round(+$('#sCountCustom').value) : 0;
  $('#sCost').textContent = !count
    ? `결과 수를 1~${SEARCH_MAX} 사이로 입력하면 예상 할당량을 보여줍니다`
    : `예상 할당량: 약 ${(pages * 100 + extra).toLocaleString()} 유닛 (검색 1회 = 100 · 제외·종류 조건으로 빠진 만큼 더 검색하면 늘어남)`
      + (typed > SEARCH_MAX ? ` · YouTube 검색은 최대 ${SEARCH_MAX}건까지라 ${SEARCH_MAX}건으로 검색합니다` : '');
  const isVideo = $('#sType').value === 'video';
  $('#sKind').disabled = !isVideo;
  // 채널 검색에는 영상 제목·태그가 없어 설명·채널명 칸만 쓴다
  ['#sExTitle', '#sExTags'].forEach(s => { $(s).disabled = !isVideo; });
  const custom = $('#sPeriod').value === 'custom';
  $('#sDates').hidden = !custom;
  if (custom && !$('#sTo').value) {
    const today = new Date();
    $('#sTo').value = today.toLocaleDateString('sv-SE');
    $('#sFrom').value = new Date(today - 30 * 864e5).toLocaleDateString('sv-SE');
  }
  $('#sFrom').max = $('#sTo').max = new Date().toLocaleDateString('sv-SE');
}

// 한 번의 검색 조건과 진행 상태. "더 검색"은 여기서 이어서 다음 페이지를 가져온다.
let searchSession = null;

async function runSearch() {
  const q = $('#sQuery').value.trim();
  if (!q) return toast('검색어를 입력해 주세요.');
  const type = $('#sType').value, count = searchCount();
  if (!count) return toast(`결과 수를 1~${SEARCH_MAX} 사이로 입력해 주세요.`);
  // YouTube 검색은 비슷한 말까지 넓게 잡으므로(예: 페이 → 페이커) 위치별 제외 단어로 결과를 거른다
  const words = sel => unique($(sel).value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const ex = {
    title: words('#sExTitle'),
    desc: words('#sExDesc'),
    tags: type === 'video' ? words('#sExTags') : [],
    channel: words('#sExChannel'),
  };
  const hasAny = (text, list) => list.length > 0 && list.some(w => (text || '').toLowerCase().includes(w));
  // YouTube의 -단어 연산자는 제목·설명·태그 어디에 있든 빼므로, 세 칸 모두에 넣은 단어만 보내 검색 낭비를 줄인다
  const everywhere = type === 'video'
    ? ex.title.filter(w => ex.desc.includes(w) && ex.tags.includes(w))
    : [];
  // 쉼표로 나눈 검색어는 "하나라도 포함"(YouTube의 | 연산자)으로 보낸다
  const orQuery = q.split(/[,|]/).map(s => s.trim()).filter(Boolean).join(' | ');
  const apiQuery = orQuery + everywhere.map(w => ` -${/\s/.test(w) ? `"${w}"` : w}`).join('');
  const excludeCount = ex.title.length + ex.desc.length + ex.tags.length + ex.channel.length;
  const period = $('#sPeriod').value, kind = $('#sKind').value, order = $('#sOrder').value;
  let publishedAfter, publishedBefore;
  if (period === 'custom') {
    const from = $('#sFrom').value, to = $('#sTo').value;
    if (!from && !to) return toast('기간을 입력해 주세요.');
    if (from && to && from > to) return toast('시작일이 종료일보다 늦습니다.');
    // 입력한 날짜는 내 시간대 기준 하루 전체로 본다
    if (from) publishedAfter = new Date(`${from}T00:00:00`).toISOString();
    if (to) publishedBefore = new Date(`${to}T23:59:59.999`).toISOString();
  } else if (period) {
    publishedAfter = new Date(Date.now() - +period * 864e5).toISOString();
  }

  const session = {
    q, type, kind,
    params: {
      part: 'snippet', type, q: apiQuery,
      order,
      regionCode: $('#sRegion').value,
      relevanceLanguage: $('#sRegion').value === 'KR' ? 'ko' : undefined,
      publishedAfter,
      publishedBefore,
      // 쇼츠 필터가 없어 쇼츠만 찾을 땐 4분 미만으로 후보를 좁히고, 아래에서 쇼츠 판별로 다시 거른다
      videoDuration: type === 'video' && kind === 'short' ? 'short' : undefined,
    },
    filtering: excludeCount > 0 || (type === 'video' && kind !== 'all'),
    keep: type === 'video'
      ? v => (hasAny(v.title, ex.title) || hasAny(v.description, ex.desc) || hasAny(v.tags, ex.tags) || hasAny(v.channelTitle, ex.channel) ? 'excluded'
        : kind !== 'all' && (kind === 'short') !== v.isShort ? 'kind' : 'ok')
      : c => (hasAny(c.description, ex.desc) || hasAny(`${c.title} ${c.handle}`, ex.channel) ? 'excluded' : 'ok'),
    results: [],
    seen: new Set(),      // 이미 받은 결과(직접 삭제한 것 포함)는 다시 가져오지 않는다
    buffer: [],           // 받아 놓고 아직 쓰지 않은 결과 (다음 "더 검색" 때 먼저 쓴다)
    pageToken: undefined,
    started: false,
    dropped: 0, kindDropped: 0, removed: 0,
    undo: [],             // 삭제 취소용: [{ item, index }]
    sort: {},
  };
  const { quotaMsg } = await searchMore(session, count);
  if (!session.results.length) {
    if (quotaMsg) throw new ApiError(explainError(403, { errors: [{ reason: 'quotaExceeded' }] }), 'quotaExceeded');
    setStatus('#sStatus', '조건에 맞는 검색 결과가 없습니다.', '');
    $('#sResult').innerHTML = '';
    return;
  }
  searchSession = session;
  renderSearch();
  if (quotaMsg) quotaNotice('#sStatus', quotaMsg);
}

// 조건에 맞는 결과를 n건 더 모은다. 제외·종류 조건으로 빠진 만큼 다음 페이지에서 채우되,
// 검색 1회가 100 유닛이라 조건이 너무 좁을 때 할당량을 다 쓰지 않도록 추가 검색은 3페이지까지만 한다.
async function searchMore(session, n) {
  const added = [];
  const take = it => {
    session.seen.add(it.id);
    const r = session.keep(it);
    if (r === 'excluded') session.dropped++;
    else if (r === 'kind') session.kindDropped++;
    else added.push(it);
  };
  while (session.buffer.length && added.length < n) take(session.buffer.shift());
  const maxPages = Math.ceil(n / 50) + (session.filtering ? 3 : 0);
  let pages = 0, quotaMsg = '';
  try {
    while (added.length < n && pages < maxPages && (!session.started || session.pageToken)) {
      setStatus('#sStatus', `검색 중… ${added.length}/${n}건`, 'busy');
      const want = session.filtering ? 50 : Math.min(50, n - added.length);
      const d = await yt('search', { ...session.params, maxResults: want, pageToken: session.pageToken });
      session.started = true;
      pages++;
      session.pageToken = d.nextPageToken;
      const ids = d.items.map(i => (session.type === 'video' ? i.id.videoId : i.id.channelId)).filter(id => id && !session.seen.has(id));
      ids.forEach(id => session.seen.add(id));
      if (!ids.length) continue;
      const items = session.type === 'video' ? await fetchVideos(ids) : await fetchChannels(ids);
      for (const it of items) {
        if (added.length < n) take(it); else session.buffer.push(it);
      }
    }
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    quotaMsg = `${n}건 중 ${added.length}건까지만 검색했습니다.`;
  }
  if (session.type === 'video' && added.length && !quotaMsg) {
    setStatus('#sStatus', '구독자 수 불러오는 중…', 'busy');
    try { await attachChannelStats(added); }
    catch (e) {
      if (!isQuotaError(e)) throw e;
      quotaMsg = '검색 결과는 불러왔지만 구독자 수는 불러오지 못했습니다.';
    }
  }
  session.results.push(...added);
  session.shortfall = !quotaMsg && added.length < n;
  return { added: added.length, quotaMsg };
}

const searchChannelCols = [
  channelCol,
  { key: 'subs', label: '구독자', type: 'num' },
  { key: 'totalViews', label: '총 조회수', type: 'num' },
  { key: 'videoCount', label: '총 영상', type: 'num' },
  { key: 'lifetimeAvgViews', label: '영상당 평균 조회수(누적)', type: 'num' },
  { key: 'createdAt', label: '개설일', type: 'date' },
  { key: 'country', label: '국가', type: 'text' },
];
const deleteCol = {
  key: '_del', label: '삭제', type: 'text', sortable: false, cls: 'del',
  html: r => `<button type="button" class="row-del" data-del="${esc(r.id)}" title="목록에서 삭제" aria-label="목록에서 삭제">×</button>`,
};

function renderSearch() {
  const s = searchSession;
  const list = s.results;
  searchResults = list;
  const isVideo = s.type === 'video';
  const cols = isVideo ? videoCols(true) : searchChannelCols;
  const exhausted = s.started && !s.pageToken && !s.buffer.length;
  const notes = [
    s.dropped ? `제외 단어가 들어간 ${s.dropped}건` : '',
    s.kindDropped ? `${s.kind === 'short' ? '쇼츠' : '일반 영상'}가 아닌 ${s.kindDropped}건` : '',
  ].filter(Boolean);
  const sub = [
    notes.length ? `${notes.join(', ')}을 빼고 다시 채웠습니다` : '',
    s.removed ? `직접 삭제한 ${s.removed}건` : '',
    exhausted ? '더 이상 검색 결과가 없습니다' : s.shortfall ? '조건에 맞는 결과가 적어 요청한 수보다 적게 찾았습니다' : '',
    isVideo ? '' : '정확한 최근 성과는 “채널별 비교로 보내기” 후 확인하세요.',
  ].filter(Boolean).join(' · ');
  const csvCols = isVideo
    ? [...cols, ...videoCsvExtra]
    : [{ key: 'title', label: '채널명', type: 'text' }, { key: 'handle', label: '핸들', type: 'text' }, { key: 'id', label: '채널ID', type: 'text' }, { key: 'url', label: 'URL', type: 'text' }, ...cols.slice(1)];
  const body = block($('#sResult'), {
    title: `“${s.q}” ${isVideo ? '영상' : '채널'} 검색 결과 ${list.length}건`,
    sub,
    actions: [
      ...(isVideo ? [
        { label: '영상들을 영상별 비교로 보내기', run: () => sendToVideos(list.map(v => v.id)) },
        { label: '채널들을 채널별 비교로 보내기', run: () => sendToChannels(list.map(v => v.channelId)) },
      ] : [
        { label: '채널별 비교로 보내기', run: () => sendToChannels(list.map(c => c.id)) },
      ]),
      { label: 'CSV 다운로드', run: () => downloadCSV(`${isVideo ? '검색' : '채널검색'}_${s.q}`, csvCols, list) },
    ],
  });
  body.innerHTML = `
    <div class="more-bar">
      <label class="inline">결과
        <select id="sMoreN"><option>10</option><option selected>25</option><option>50</option></select>
        건 <button type="button" id="sMore" class="ghost small" ${exhausted ? 'disabled' : ''}>더 검색하기</button>
      </label>
      <span class="muted">${exhausted ? '더 가져올 결과가 없습니다' : '이미 받은 결과와 삭제한 결과는 다시 나오지 않습니다 · 검색 1회 100 유닛'}</span>
      <button type="button" id="sUndo" class="ghost small undo" ${s.undo.length ? '' : 'disabled'}>↶ 삭제 취소${s.undo.length ? ` (${s.undo.length})` : ''}</button>
    </div>
    <div class="stable"></div>`;
  const tableEl = $('.stable', body);
  const table = renderTable(tableEl, [deleteCol, ...cols], list, s.sort);
  tableEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    s.sort = table.sortState();
    const index = s.results.findIndex(r => r.id === btn.dataset.del);
    if (index < 0) return;
    s.undo.push({ item: s.results[index], index });
    s.results.splice(index, 1);
    s.removed++;
    renderSearch();
  });
  $('#sUndo', body).onclick = () => {
    const last = s.undo.pop();
    if (!last) return;
    s.sort = table.sortState();
    s.results.splice(Math.min(last.index, s.results.length), 0, last.item);
    s.removed--;
    renderSearch();
  };
  $('#sMore', body).onclick = () => run($('#sMore', body), '#sStatus', async () => {
    s.sort = table.sortState();
    const n = +$('#sMoreN', body).value;
    const { added, quotaMsg } = await searchMore(s, n);
    renderSearch();
    if (quotaMsg) return added ? quotaNotice('#sStatus', quotaMsg) : setStatus('#sStatus', explainError(403, { errors: [{ reason: 'quotaExceeded' }] }), 'error');
    setStatus('#sStatus', added ? `${added}건을 더 찾았습니다.` : '조건에 맞는 결과를 더 찾지 못했습니다.', added ? 'ok' : '');
  });
}

function sendToChannels(ids) {
  $('#chInput').value = unique(ids).join('\n');
  switchTab('channels');
  toast(`채널 ${unique(ids).length}개를 입력했습니다. “분석하기”를 눌러 주세요.`);
}

function sendToVideos(ids) {
  $('#vInput').value = unique(ids).map(id => `https://www.youtube.com/watch?v=${id}`).join('\n');
  switchTab('videos');
  toast(`영상 ${unique(ids).length}개를 입력했습니다. “분석하기”를 눌러 주세요.`);
}

/* ---------------- 탭: 댓글 수집 ---------------- */

let commentData = { video: null, comments: [] };

const STOPWORDS = new Set(('그리고 그래서 그런데 근데 하지만 그냥 진짜 정말 너무 완전 이거 저거 그거 이건 저건 그건 이게 그게 저게 여기 거기 저는 제가 나는 내가 우리 이런 저런 그런 있는 없는 하는 해서 하고 같아요 같은 있어요 합니다 입니다 ' +
  'the and to is of a in it this that for you i my me so are was be on with just not but have its your').split(' '));

const tokenize = t => t.toLowerCase().split(/[^\p{L}\p{N}]+/u);

function topWords(texts, limit = 40) {
  const freq = new Map();
  for (const t of texts) {
    const seen = new Set();
    for (const w of tokenize(t)) {
      if (w.length < 2 || STOPWORDS.has(w) || /^[ㅋㅎㅠㅜ]+$/.test(w) || /^\d+$/.test(w) || seen.has(w)) continue;
      seen.add(w);
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function runComments() {
  const id = parseVideoId($('#cVideo').value);
  if (!id) return toast('영상 URL이나 ID를 입력해 주세요.');
  const all = $('#cMax').value === 'all';
  const max = all ? Infinity : +$('#cMax').value, order = $('#cOrder').value;

  setStatus('#cStatus', '영상 정보 확인 중…', 'busy');
  const [video] = await fetchVideos([id]);
  if (!video) throw new Error('영상을 찾을 수 없습니다.');
  // 댓글 100개당 1 유닛이라 댓글이 아주 많은 영상은 전체 수집 전에 확인을 받는다 (댓글 수에는 답글도 포함돼 실제보다 크게 잡힌다)
  const estimate = Math.ceil((video.comments || 0) / 100);
  if (all && estimate > 200 && !confirm(`이 영상은 댓글이 약 ${fmt.num(video.comments)}개라 전체 수집에 할당량이 최대 ${fmt.num(estimate)} 유닛 정도 쓰일 수 있습니다. 계속할까요?`)) {
    setStatus('#cStatus', '댓글 수집을 취소했습니다.', '');
    return;
  }

  const comments = [];
  let pageToken, quotaHit = false;
  try {
    do {
      setStatus('#cStatus', `댓글 수집 중… ${comments.length.toLocaleString()}개`, 'busy');
      const d = await yt('commentThreads', { part: 'snippet', videoId: id, maxResults: 100, order, textFormat: 'plainText', pageToken });
      for (const it of d.items) {
        const s = it.snippet.topLevelComment.snippet;
        comments.push({
          id: it.id,
          author: s.authorDisplayName,
          authorUrl: s.authorChannelUrl,
          text: s.textOriginal ?? s.textDisplay ?? '',
          likes: s.likeCount || 0,
          replies: it.snippet.totalReplyCount || 0,
          publishedAt: new Date(s.publishedAt),
          edited: s.updatedAt !== s.publishedAt,
        });
      }
      pageToken = d.nextPageToken;
    } while (pageToken && comments.length < max);
  } catch (e) {
    if (!isQuotaError(e) || !comments.length) throw e;
    quotaHit = true;
  }

  commentData = { video, comments: comments.slice(0, max), filter: null };
  renderComments();
  if (quotaHit) quotaNotice('#cStatus', `댓글 ${fmt.num(comments.length)}개까지만 수집했습니다.`);
}

function renderComments() {
  const { video, comments } = commentData;
  if (!video) return;
  const keywords = $('#cKeywords').value.split(',').map(s => s.trim()).filter(Boolean);
  const lower = comments.map(c => c.text.toLowerCase());
  const mentions = keywords.map(k => {
    const kl = k.toLowerCase();
    const n = lower.filter(t => t.includes(kl)).length;
    return [k, n];
  });

  const cols = [
    { key: 'author', label: '작성자', type: 'text', html: r => r.authorUrl ? `<a href="${esc(r.authorUrl)}" target="_blank" rel="noopener">${esc(r.author)}</a>` : esc(r.author) },
    { key: 'text', label: '댓글', type: 'text', cls: 'text' },
    { key: 'likes', label: '좋아요', type: 'num' },
    { key: 'replies', label: '답글', type: 'num' },
    { key: 'publishedAt', label: '작성일', type: 'date' },
  ];
  const csvCols = [
    ...cols.slice(0, 2),
    ...keywords.map(k => ({ key: 'kw_' + k, label: `언급:${k}`, type: 'text', csv: r => (r.text.toLowerCase().includes(k.toLowerCase()) ? 1 : 0) })),
    ...cols.slice(2),
    { key: 'authorUrl', label: '작성자 채널', type: 'text' },
    { key: 'id', label: '댓글ID', type: 'text' },
  ];

  const body = block($('#cResult'), {
    title: video.title,
    sub: `${esc(video.channelTitle)} · 조회수 ${fmt.num(video.views)} · 전체 댓글 ${fmt.num(video.comments)}개(답글 포함) 중 ${fmt.num(comments.length)}개 수집`,
    actions: [{
      label: 'CSV 다운로드',
      run: () => {
        const f = commentData.filter;
        downloadCSV(`댓글_${video.id}${f ? '_' + f.value : ''}`, csvCols, f ? visible() : comments);
      },
    }],
  });

  // 단어(토큰 일치) 또는 언급 키워드(부분 일치)로 댓글 거르기. 자주 쓰인 단어의 개수와 같은 기준이다.
  const tokenSets = comments.map(c => new Set(tokenize(c.text)));
  const matches = (f, i) => (f.kind === 'word' ? tokenSets[i].has(f.value) : lower[i].includes(f.value.toLowerCase()));
  const visible = () => {
    const f = commentData.filter;
    return f ? comments.filter((_, i) => matches(f, i)) : comments;
  };
  if (commentData.filter?.kind === 'kw' && !keywords.includes(commentData.filter.value)) commentData.filter = null;

  const likes = comments.map(c => c.likes);
  const words = topWords(comments.map(c => c.text));
  body.innerHTML = statCards([
    ['수집 댓글', fmt.num(comments.length)],
    ['댓글 좋아요 합계', fmt.compact(sum(likes)), `평균 ${fmt.dec(mean(likes))}`],
    ['답글 합계', fmt.num(sum(comments.map(c => c.replies)))],
    ['답글 달린 댓글', fmt.pct(comments.length ? comments.filter(c => c.replies > 0).length / comments.length : null), '대화가 일어나는 비율'],
    ['영상 댓글율', fmt.pct(video.commentRate), '댓글 ÷ 조회수'],
  ]) + `
    <div class="two-col">
      <div><h4>자주 쓰인 단어 <span class="muted">(댓글 수 기준)</span></h4>
        <div class="chips">${words.map(([w, n]) => `<button type="button" class="chip" data-kind="word" data-value="${esc(w)}">${esc(w)}<b>${n}</b></button>`).join('') || '<span class="muted">-</span>'}</div></div>
      <div><h4>언급 키워드</h4>
        ${keywords.length ? `<div class="chips">${mentions.map(([k, n]) => `<button type="button" class="chip" data-kind="kw" data-value="${esc(k)}">${esc(k)}<b>${n}개 · ${fmt.pct(comments.length ? n / comments.length : 0)}</b></button>`).join('')}</div>`
          : '<span class="muted">위 “언급 키워드” 칸에 브랜드명·제품명을 입력하면 언급 댓글 수와 비율을 보여줍니다. 입력 후 다시 수집할 필요는 없습니다.</span>'}</div>
    </div>
    <div class="cfilter"></div>
    <div class="ctable"></div>`;

  const applyFilter = () => {
    const f = commentData.filter;
    body.querySelectorAll('.chip[data-kind]').forEach(c => {
      const on = !!f && c.dataset.kind === f.kind && c.dataset.value === f.value;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on);
    });
    const rows = visible();
    $('.cfilter', body).innerHTML = f
      ? `<span><b>“${esc(f.value)}”</b> ${f.kind === 'word' ? '포함' : '언급'} 댓글 ${fmt.num(rows.length)}개 표시 중</span><button type="button" class="ghost small" data-clear>필터 해제</button>`
      : '<span class="muted">단어를 누르면 그 단어가 들어간 댓글만 볼 수 있습니다.</span>';
    renderTable($('.ctable', body), cols, rows);
  };
  body.querySelector('.two-col').onclick = e => {
    const chip = e.target.closest('.chip[data-kind]');
    if (!chip) return;
    const f = commentData.filter;
    const same = f && f.kind === chip.dataset.kind && f.value === chip.dataset.value;
    commentData.filter = same ? null : { kind: chip.dataset.kind, value: chip.dataset.value };
    applyFilter();
  };
  $('.cfilter', body).onclick = e => {
    if (e.target.closest('[data-clear]')) { commentData.filter = null; applyFilter(); }
  };
  applyFilter();
}

/* ---------------- 탭: 썸네일 다운로드 ---------------- */

let thumbResults = [];
const THUMB_SIZES = [['maxres', '최대'], ['standard', '고화질'], ['high', '높음'], ['medium', '중간'], ['default', '작게']];

// API가 알려준 실제로 있는 크기만 큰 것부터 (maxres는 영상에 따라 없을 수 있다)
const thumbOptions = v => THUMB_SIZES
  .filter(([k]) => v.thumbs[k]?.url)
  .map(([k, label]) => ({ key: k, label, ...v.thumbs[k] }));

const thumbFileName = (v, o) => `${(v.title.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || v.id)}_${o.width}x${o.height}.jpg`;

// 다른 사이트 이미지는 a[download]로 바로 저장되지 않아 blob으로 받아 저장한다.
// 브라우저가 막으면(CORS) 새 탭으로 열어 직접 저장하게 한다.
async function downloadImage(url, filename) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  } catch {
    window.open(url, '_blank', 'noopener');
    toast('바로 저장이 막혀 새 탭으로 열었습니다. 이미지를 우클릭해 저장해 주세요.');
    return false;
  }
}

async function runThumbs() {
  const lines = $('#tInput').value.split('\n').map(s => s.trim()).filter(Boolean);
  const ids = unique(lines.map(parseVideoId).filter(Boolean));
  const bad = lines.filter(l => !parseVideoId(l));
  if (!ids.length) return toast('영상 URL이나 ID를 입력해 주세요.');

  const vids = [];
  let checked = 0, quotaHit = false;
  try {
    for (const part of chunk(ids, 50)) {
      setStatus('#tStatus', `영상 ${ids.length}개 확인 중… ${checked}개 완료`, 'busy');
      vids.push(...await fetchVideos(part));
      checked += part.length;
    }
  } catch (e) {
    if (!isQuotaError(e) || !vids.length) throw e;
    quotaHit = true;
  }
  thumbResults = vids;
  const missing = checked - vids.length;

  const body = block($('#tResult'), {
    title: `썸네일 ${vids.length}개`,
    sub: [missing ? `비공개·삭제 등으로 ${missing}개를 불러오지 못했습니다` : '', bad.length ? `인식하지 못한 줄 ${bad.length}개` : ''].filter(Boolean).join(' · '),
    actions: vids.length > 1 ? [{
      label: '전체를 가장 큰 크기로 받기',
      run: async () => {
        for (const v of thumbResults) {
          const best = thumbOptions(v)[0];
          if (!best) continue;
          // 한 번이라도 막히면 탭이 여러 개 열리지 않도록 멈춘다
          if (!await downloadImage(best.url, thumbFileName(v, best))) break;
          await new Promise(r => setTimeout(r, 300));
        }
      },
    }] : [],
  });
  body.innerHTML = `<div class="thumb-grid">${vids.map((v, i) => {
    const opts = thumbOptions(v);
    const best = opts[0];
    return `<figure class="thumb-card">
      ${best ? `<a href="${esc(best.url)}" target="_blank" rel="noopener" class="thumb-img"><img src="${esc(best.url)}" alt="" loading="lazy"></a>` : '<div class="thumb-img empty">썸네일 없음</div>'}
      <figcaption>
        <a class="thumb-title" href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)}</a>
        <div class="muted">${esc(v.channelTitle)}</div>
        <div class="thumb-sizes">${opts.map(o => `<button type="button" class="ghost small" data-i="${i}" data-size="${o.key}">${o.label} ${o.width}×${o.height}</button>`).join('')}</div>
      </figcaption>
    </figure>`;
  }).join('')}</div>`;
  body.onclick = e => {
    const btn = e.target.closest('[data-size]');
    if (!btn) return;
    const v = thumbResults[+btn.dataset.i];
    const o = thumbOptions(v).find(x => x.key === btn.dataset.size);
    if (o) downloadImage(o.url, thumbFileName(v, o));
  };
  if (quotaHit) quotaNotice('#tStatus', `영상 ${ids.length}개 중 ${checked}개까지만 불러왔습니다.`);
}

/* ---------------- 탭: 설정 ---------------- */

function initSettings() {
  const input = $('#keyInput');
  input.value = getKey();
  $('#keyRemember').checked = store('yt_api_key') !== null || !memKey;
  $('#keyShow').onclick = () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#keyShow').textContent = input.type === 'password' ? '보기' : '숨기기';
  };
  $('#keySave').onclick = () => {
    const k = input.value.trim();
    if (!k) return setStatus('#keyMsg', 'API 키를 입력해 주세요.', 'error');
    memKey = k;
    store('yt_api_key', $('#keyRemember').checked ? k : null);
    renderStatus();
    setStatus('#keyMsg', '저장했습니다. “연결 테스트”로 확인해 보세요.', 'ok');
  };
  $('#keyTest').onclick = () => run($('#keyTest'), '#keyMsg', async () => {
    if (input.value.trim() && input.value.trim() !== getKey()) $('#keySave').onclick();
    setStatus('#keyMsg', '테스트 중…', 'busy');
    await yt('videos', { part: 'id', id: 'dQw4w9WgXcQ' });
    setStatus('#keyMsg', '연결 성공! 이제 다른 탭에서 데이터를 추출할 수 있습니다.', 'ok');
  });
  $('#keyDelete').onclick = () => {
    memKey = '';
    store('yt_api_key', null);
    input.value = '';
    renderStatus();
    setStatus('#keyMsg', 'API 키를 삭제했습니다.', '');
  };
}

/* ---------------- 첫 방문 API 키 팝업 ---------------- */

// 테스트 호출이 통과하면 키를 확정한다. 할당량 초과는 키 자체는 유효하다는 뜻이라 통과로 본다.
async function verifyKey(k) {
  const prev = memKey;
  memKey = k;
  try {
    await yt('videos', { part: 'id', id: 'dQw4w9WgXcQ' });
  } catch (e) {
    if (e.reason !== 'quotaExceeded') { memKey = prev; throw e; }
  }
}

function openKeyModal() {
  if (!$('#mSteps').firstChild) $('#mSteps').append($('#tab-settings .steps').cloneNode(true));
  $('#keyModal').hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => $('#mKey').focus(), 50);
}

function closeKeyModal() {
  $('#keyModal').hidden = true;
  document.body.classList.remove('modal-open');
}

function initKeyModal() {
  $('#mSave').onclick = () => run($('#mSave'), '#mMsg', async () => {
    const k = $('#mKey').value.trim();
    if (!k) throw new Error('API 키를 입력해 주세요.');
    setStatus('#mMsg', '키 확인 중…', 'busy');
    await verifyKey(k);
    store('yt_api_key', $('#mRemember').checked ? k : null);
    $('#keyInput').value = k;
    renderStatus();
    closeKeyModal();
    toast('API 키가 연결되었습니다.');
  });
  $('#mKey').onkeydown = e => { if (e.key === 'Enter') $('#mSave').click(); };
  $('#mClose').onclick = closeKeyModal;
  $('#keyModal').onclick = e => { if (e.target === $('#keyModal')) closeKeyModal(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#keyModal').hidden) closeKeyModal(); });
  $('#keyStatus').onclick = () => (getKey() ? switchTab('settings') : openKeyModal());
}

/* ---------------- 배경 눈 (서울) ----------------
 * Open-Meteo(키 불필요)로 서울의 현재 날씨를 받아 눈이 올 때만 배경에 눈을 내린다. 그 밖의 날씨는 배경을 바꾸지 않는다.
 * 주소에 ?weather=snow를 붙이면 눈 내리는 배경을 미리 볼 수 있다.
 */
const SEOUL = { lat: 37.5665, lon: 126.978 };
const WEATHER_TTL = 20 * 60 * 1000;

// WMO 날씨 코드 → 눈의 세기 (0 = 눈 아님)
function snowLevel(code) {
  if (code === 71 || code === 77) return 1;
  if (code === 73 || code === 85) return 2;
  if (code === 75 || code === 86) return 3;
  return 0;
}

const SnowFx = (() => {
  const canvas = $('#weatherFx');
  const ctx = canvas.getContext('2d');
  let level = 0, flakes = [], raf = 0, running = false, w = 0, h = 0;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }
  function make(anywhere) {
    const r = Math.random;
    return { x: r() * w, y: anywhere ? r() * h : -10, s: 1.2 + r() * 2.8, v: .5 + r() * 1.1, p: r() * Math.PI * 2, a: .5 + r() * .45 };
  }
  function seed() {
    const count = [0, 70, 130, 210][level] * (w * h) / (1440 * 900);
    flakes = Array.from({ length: Math.round(count) }, () => make(true));
  }
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      f.y += f.v; f.x += Math.sin(t / 1400 + f.p) * 0.45;
      if (f.y > h + 10) Object.assign(f, make(false));
      ctx.fillStyle = `rgba(255,255,255,${f.a})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.s, 0, Math.PI * 2); ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running || !flakes.length || document.hidden) return;
    running = true; raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false; cancelAnimationFrame(raf); ctx.clearRect(0, 0, w, h);
  }
  addEventListener('resize', () => { resize(); if (running) { stop(); start(); } });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : motionOn() && start()));
  resize();
  return {
    set(lv) { stop(); level = lv; seed(); if (motionOn()) start(); },
    start, stop,
  };
})();

const motionOn = () => !document.body.classList.contains('motion-off');

// 배경 빛이 화면 전체를 천천히 떠다니게 한다. 빛마다 주기가 다른 사인파 두 개를 겹쳐
// 서로 맞물리지 않는 느린 경로를 만들고, 밝기도 따로 숨 쉬듯 바뀐다.
const LightDrift = (() => {
  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const lights = [...document.querySelectorAll('.ambient span, .ambient i')].map(el => {
    const small = el.tagName === 'I';
    const px = small ? rnd(25, 45) : rnd(45, 90);   // 가로로 한 번 오가는 데 걸리는 초
    const py = px * rnd(0.7, 1.3);
    return {
      el, small, w: 0, h: 0,
      x: [px, px * rnd(0.3, 0.45), rnd(0, TAU), rnd(0, TAU)],
      y: [py, py * rnd(0.3, 0.45), rnd(0, TAU), rnd(0, TAU)],
      glow: [small ? rnd(6, 11) : rnd(14, 24), rnd(0, TAU)],
    };
  });
  let raf = 0, running = false;
  const measure = () => lights.forEach(l => { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; });
  // 0~1 범위를 약간 넘나들어 가장자리 밖까지 흘러갔다 돌아온다
  const path = ([p1, p2, a, b], t) => 0.5 + 0.44 * Math.sin(TAU * t / p1 + a) + 0.12 * Math.sin(TAU * t / p2 + b);
  function render(ms) {
    const t = ms / 1000, W = innerWidth, H = innerHeight;
    for (const l of lights) {
      const x = path(l.x, t) * W - l.w / 2, y = path(l.y, t) * H - l.h / 2;
      const g = 0.5 + 0.5 * Math.sin(TAU * t / l.glow[0] + l.glow[1]);
      l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      l.el.style.opacity = (l.small ? 0.2 + 0.8 * g : 0.55 + 0.45 * g).toFixed(3);
    }
  }
  function frame(ms) { render(ms); raf = requestAnimationFrame(frame); }
  addEventListener('resize', () => { measure(); render(performance.now()); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : motionOn() && start()));
  function start() { if (!running && !document.hidden) { running = true; raf = requestAnimationFrame(frame); } }
  function stop() { running = false; cancelAnimationFrame(raf); }
  measure();
  render(performance.now()); // 꺼진 상태에서도 빛이 화면 곳곳에 놓이도록 한 번 그린다
  return { start, stop };
})();

function setMotion(on) {
  document.body.classList.toggle('motion-off', !on);
  const btn = $('#motionToggle');
  btn.textContent = on ? '배경 움직임 끄기' : '배경 움직임 켜기';
  btn.setAttribute('aria-pressed', String(!on));
  store('yt_motion', on ? 'on' : 'off');
  if (on) { SnowFx.start(); LightDrift.start(); } else { SnowFx.stop(); LightDrift.stop(); }
}

function applySnow(level) {
  SnowFx.set(level);
  $('#motionToggle').title = level ? '서울에 눈이 와서 배경에도 눈이 내립니다' : '';
}

async function loadWeather() {
  if (new URLSearchParams(location.search).get('weather') === 'snow') return applySnow(2);
  try {
    const cached = JSON.parse(store('yt_weather') || 'null');
    if (cached && Date.now() - cached.at < WEATHER_TTL) return applySnow(snowLevel(cached.code));
  } catch { /* 캐시가 깨졌으면 새로 받는다 */ }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${SEOUL.lat}&longitude=${SEOUL.lon}&current=weather_code&timezone=Asia%2FSeoul`;
    const code = (await (await fetch(url)).json()).current?.weather_code;
    if (code == null) return;
    store('yt_weather', JSON.stringify({ at: Date.now(), code }));
    applySnow(snowLevel(code));
  } catch { /* 날씨를 못 받으면 눈 없이 기본 배경 그대로 둔다 */ }
}

/* ---------------- 탭 전환 · 초기화 ---------------- */

// 탭 이름을 누르면 그 탭의 입력값·결과를 처음 상태로 되돌린다 (API 키 설정 탭은 키가 지워지지 않도록 제외)
const PANEL_RESULTS = {
  channels: ['#chResult', '#chDetail'],
  videos: ['#vResult'],
  search: ['#sResult'],
  comments: ['#cResult'],
  thumbs: ['#tResult'],
};

function resetPanel(name) {
  if (!PANEL_RESULTS[name]) return;
  const panel = $('#tab-' + name);
  panel.querySelectorAll('input, textarea, select').forEach(el => {
    if (el.tagName === 'SELECT') el.selectedIndex = Math.max(0, [...el.options].findIndex(o => o.defaultSelected));
    else if (el.type === 'checkbox') el.checked = el.defaultChecked;
    else el.value = el.defaultValue;
  });
  panel.querySelectorAll('.status-line').forEach(el => setStatus('#' + el.id, ''));
  PANEL_RESULTS[name].forEach(sel => { $(sel).innerHTML = ''; });
  if (name === 'channels') channelResults = [];
  if (name === 'videos') videoResults = [];
  if (name === 'search') { searchSession = null; searchResults = []; updateSearchCost(); }
  if (name === 'comments') commentData = { video: null, comments: [] };
  if (name === 'thumbs') thumbResults = [];
}

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  store('yt_tab', name);
}

function init() {
  document.querySelectorAll('.tabs button').forEach(b => {
    b.onclick = () => {
      resetPanel(b.dataset.tab);
      switchTab(b.dataset.tab);
      window.scrollTo({ top: 0 });
    };
  });
  $('#chRun').onclick = () => run($('#chRun'), '#chStatus', runChannels);
  $('#vRun').onclick = () => run($('#vRun'), '#vStatus', runVideos);
  $('#sRun').onclick = () => run($('#sRun'), '#sStatus', runSearch);
  $('#cRun').onclick = () => run($('#cRun'), '#cStatus', runComments);
  $('#tRun').onclick = () => run($('#tRun'), '#tStatus', runThumbs);
  ['#sQuery', '#sExTitle', '#sExDesc', '#sExTags', '#sExChannel'].forEach(s => {
    $(s).onkeydown = e => { if (e.key === 'Enter') $('#sRun').click(); };
  });
  $('#cVideo').onkeydown = e => { if (e.key === 'Enter') $('#cRun').click(); };
  $('#cKeywords').oninput = () => renderComments();
  ['#sType', '#sCount', '#sPeriod'].forEach(s => { $(s).onchange = updateSearchCost; });
  $('#sCountCustom').oninput = updateSearchCost;
  $('#sCountInfo').onclick = e => { e.stopPropagation(); toggleCountInfo(); };
  document.addEventListener('click', e => { if (!$('#sCountPop').hidden && !e.target.closest('#sCountPop')) toggleCountInfo(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sCountPop').hidden) toggleCountInfo(false); });
  $('#sCountCustom').onkeydown = e => { if (e.key === 'Enter') $('#sRun').click(); };
  updateSearchCost();
  initSettings();
  initKeyModal();
  const savedMotion = store('yt_motion');
  setMotion(savedMotion ? savedMotion === 'on' : !matchMedia('(prefers-reduced-motion: reduce)').matches);
  $('#motionToggle').onclick = () => setMotion(!motionOn());
  loadWeather();
  setInterval(loadWeather, WEATHER_TTL);
  renderStatus();
  switchTab(store('yt_tab') || 'channels');
  if (!getKey()) openKeyModal();
}

init();
