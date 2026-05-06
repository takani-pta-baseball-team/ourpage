import { CONFIG } from '../config.js';
import { fetchJSON, writeJSON, writeBinary, deleteFile, ConflictError } from '../api.js';
import { renderHeader, renderNav, requireAuth, showToast, escapeHtml, formatDate, uid, todayISO } from '../app.js';
import { processImage, blobToBase64 } from '../imageutil.js';
import {
  RESULT_TYPES,
  isOut,
  resultLabel,
  resultShort,
  computeNextInning,
  outsInInning,
  runsInInning,
  deriveInningsFromPlays,
} from '../plays.js';

renderHeader();
renderNav('games');

let gamesState = { games: [] };
let gamesSha = null;
let membersState = { members: [] };

requireAuth(async () => {
  await Promise.all([loadGames(), loadMembers()]);
  render();
  document.getElementById('add-game-btn').addEventListener('click', openAddDialog);
});

async function loadGames() {
  const { data, sha } = await fetchJSON(CONFIG.DATA_PATHS.games);
  gamesState = data || { games: [] };
  gamesSha = sha;
}

async function loadMembers() {
  const { data } = await fetchJSON(CONFIG.DATA_PATHS.members);
  membersState = data || { members: [] };
}

function render() {
  const list = document.getElementById('games-list');
  const games = [...gamesState.games].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (games.length === 0) {
    list.innerHTML = '<div class="empty">まだ試合が登録されていません。<br>「＋ 新規登録」から登録してください。</div>';
    return;
  }
  list.innerHTML = games.map((g) => renderGameCard(g)).join('');
  list.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEditDialog(btn.dataset.edit));
  });
  list.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteGame(btn.dataset.delete));
  });
  list.querySelectorAll('[data-photo]').forEach((el) => {
    el.addEventListener('click', () => {
      const gameId = el.dataset.gameId;
      const idx = Number(el.dataset.photoIndex);
      const game = gamesState.games.find((x) => x.id === gameId);
      if (game) openLightbox(game.photos || [], idx, game);
    });
  });
  list.querySelectorAll('[data-stats]').forEach((btn) => {
    btn.addEventListener('click', () => openStatsDialog(btn.dataset.stats));
  });
  list.querySelectorAll('[data-plays]').forEach((btn) => {
    btn.addEventListener('click', () => openPlaysDialog(btn.dataset.plays));
  });
}

function renderCardScoreboard(g) {
  const opponent = escapeHtml(g.opponent || '相手');
  // 打席記録があれば自動で集計したイニングを使う
  const derivedInnings = deriveInningsFromPlays(
    g.ourPlays,
    g.oppPlays,
    !!g.isHome,
    g.oursRunsAdj,
    g.oppsRunsAdj,
  );
  const innings = derivedInnings && derivedInnings.length > 0
    ? derivedInnings
    : g.innings;
  if (!innings || innings.length === 0) {
    return `
      <div class="score-line">
        <span>当チーム</span>
        <span class="score-num">${g.ourScore ?? 0}</span>
        <span class="vs">-</span>
        <span class="score-num">${g.theirScore ?? 0}</span>
        <span>${opponent}</span>
      </div>
    `;
  }
  const isHome = !!g.isHome;
  const topName = isHome ? opponent : '当ﾁｰﾑ';
  const bottomName = isHome ? '当ﾁｰﾑ' : opponent;
  const headerCells = innings.map((_, i) => `<th>${i + 1}</th>`).join('');
  const topCells = innings.map((inn) => `<td>${inn.top ?? 0}</td>`).join('');
  const bottomCells = innings.map((inn) => `<td>${inn.bottom ?? 0}</td>`).join('');
  const totTop = innings.reduce((s, i) => s + (i.top || 0), 0);
  const totBottom = innings.reduce((s, i) => s + (i.bottom || 0), 0);
  return `
    <div class="scoreboard-display">
      <table>
        <thead>
          <tr><th></th>${headerCells}<th>計</th></tr>
        </thead>
        <tbody>
          <tr class="${isHome ? '' : 'us-row'}">
            <td class="team-name">${topName}</td>${topCells}<td class="total">${totTop}</td>
          </tr>
          <tr class="${isHome ? 'us-row' : ''}">
            <td class="team-name">${bottomName}</td>${bottomCells}<td class="total">${totBottom}</td>
          </tr>
        </tbody>
      </table>
      ${derivedInnings ? '<div style="font-size:.7rem;color:var(--color-text-muted);text-align:right;margin-top:2px">📝 打席記録から自動計算</div>' : ''}
    </div>
  `;
}

// ========== 選手成績 ==========
const BATTING_FIELDS = [
  { key: 'singles', label: 'ヒット' },
  { key: 'doubles', label: '二塁打' },
  { key: 'triples', label: '三塁打' },
  { key: 'homeRuns', label: '本塁打' },
  { key: 'rbis', label: '打点' },
  { key: 'strikeouts', label: '三振' },
  { key: 'flyOuts', label: 'フライアウト' },
  { key: 'groundOuts', label: 'ゴロアウト' },
  { key: 'reachedOnError', label: 'エラー(出塁)' },
];

const PITCHING_COUNTER_FIELDS = [
  { key: 'strikeouts', label: '奪三振' },
  { key: 'walks', label: '四球' },
  { key: 'hitBatters', label: '死球' },
  { key: 'errors', label: 'エラー' },
  { key: 'hitsAllowed', label: '被安打' },
];

function emptyPlayerStats() {
  return {
    batting: Object.fromEntries(BATTING_FIELDS.map((f) => [f.key, 0])),
    pitching: {
      decision: null,
      ...Object.fromEntries(PITCHING_COUNTER_FIELDS.map((f) => [f.key, 0])),
    },
  };
}

function isStatsEmpty(s) {
  if (!s) return true;
  const b = s.batting || {};
  const p = s.pitching || {};
  const battingEmpty = BATTING_FIELDS.every((f) => !(b[f.key] > 0));
  const pitchingEmpty = !p.decision && PITCHING_COUNTER_FIELDS.every((f) => !(p[f.key] > 0));
  return battingEmpty && pitchingEmpty;
}

function summaryText(stats) {
  const b = stats.batting;
  const hits = (b.singles || 0) + (b.doubles || 0) + (b.triples || 0) + (b.homeRuns || 0);
  const pa = hits + (b.strikeouts || 0) + (b.flyOuts || 0) + (b.groundOuts || 0) + (b.reachedOnError || 0);
  const dec = stats.pitching.decision === 'win' ? '勝' : stats.pitching.decision === 'loss' ? '負' : '';
  if (pa === 0 && !dec && PITCHING_COUNTER_FIELDS.every((f) => !(stats.pitching[f.key] > 0))) {
    return '<span style="color:var(--color-text-muted)">未入力</span>';
  }
  const parts = [];
  if (pa > 0) parts.push(`${pa}打席 ${hits}安打`);
  if (b.rbis > 0) parts.push(`打点${b.rbis}`);
  if (dec) parts.push(`投手:${dec}`);
  return parts.join(' / ');
}

function renderStatRow(cat, field, value) {
  return `
    <div class="stat-row" data-cat="${cat}" data-key="${field.key}">
      <span class="stat-label">${field.label}</span>
      <div class="stat-controls">
        <button type="button" class="stat-btn" data-op="dec" aria-label="減らす">−</button>
        <span class="stat-value">${value || 0}</span>
        <button type="button" class="stat-btn stat-btn-plus" data-op="inc" aria-label="増やす">+</button>
      </div>
    </div>
  `;
}

function renderStatsMemberCard(member, stats) {
  return `
    <div class="stats-member-card" data-member-id="${member.id}">
      <button type="button" class="stats-member-header">
        <span class="stats-member-name">${member.number != null ? `<span class="num-badge">#${member.number}</span> ` : ''}${escapeHtml(member.name)}</span>
        <span class="stats-member-summary">${summaryText(stats)}</span>
        <span class="stats-member-toggle">▼</span>
      </button>
      <div class="stats-member-body">
        <div class="stats-section">
          <h5>打撃</h5>
          ${BATTING_FIELDS.map((f) => renderStatRow('batting', f, stats.batting[f.key])).join('')}
        </div>
        <div class="stats-section">
          <h5>投手</h5>
          <div class="stat-row" data-cat="pitching" data-key="decision">
            <span class="stat-label">勝/負</span>
            <div class="decision-buttons">
              <button type="button" class="dec-btn ${stats.pitching.decision === 'win' ? 'active-win' : ''}" data-dec="win">勝</button>
              <button type="button" class="dec-btn ${stats.pitching.decision === 'loss' ? 'active-loss' : ''}" data-dec="loss">負</button>
              <button type="button" class="dec-btn ${!stats.pitching.decision ? 'active-none' : ''}" data-dec="">-</button>
            </div>
          </div>
          ${PITCHING_COUNTER_FIELDS.map((f) => renderStatRow('pitching', f, stats.pitching[f.key])).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button type="button" class="btn btn-sm stats-clear-btn" style="flex:1">この選手をクリア</button>
        </div>
      </div>
    </div>
  `;
}

function openStatsDialog(gameId) {
  const game = gamesState.games.find((x) => x.id === gameId);
  if (!game) return;
  if (membersState.members.length === 0) {
    showToast('先にメンバーを登録してください', 'error');
    return;
  }

  const working = {};
  for (const m of membersState.members) {
    const existing = (game.playerStats && game.playerStats[m.id]) || null;
    working[m.id] = existing
      ? { batting: { ...emptyPlayerStats().batting, ...existing.batting }, pitching: { ...emptyPlayerStats().pitching, ...existing.pitching } }
      : emptyPlayerStats();
  }

  const sortedMembers = [...membersState.members].sort((a, b) => {
    const na = a.number ?? 999, nb = b.number ?? 999;
    if (na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '', 'ja');
  });

  const html = `
    <div class="modal-backdrop open" id="stats-modal">
      <div class="modal stats-modal">
        <h3 style="margin:0 0 4px">📊 選手成績</h3>
        <div class="card-meta" style="margin-bottom:12px">
          ${escapeHtml(formatDate(game.date))} vs ${escapeHtml(game.opponent || '')}
        </div>
        <p style="font-size:.8rem;color:var(--color-text-muted);margin:0 0 8px">
          選手をタップして展開 → +/- ボタンで入力 → 最後に「保存」
        </p>
        <div class="stats-list" id="stats-list">
          ${sortedMembers.map((m) => renderStatsMemberCard(m, working[m.id])).join('')}
        </div>
        <div class="modal-actions" style="margin-top:12px">
          <button type="button" class="btn" id="stats-cancel">キャンセル</button>
          <button type="button" class="btn btn-primary" id="stats-save">保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('stats-modal');
  const list = document.getElementById('stats-list');

  function updateSummary(memberId) {
    const card = list.querySelector(`.stats-member-card[data-member-id="${memberId}"]`);
    if (card) card.querySelector('.stats-member-summary').innerHTML = summaryText(working[memberId]);
  }

  // 展開トグル
  list.querySelectorAll('.stats-member-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.closest('.stats-member-card').classList.toggle('expanded');
    });
  });

  // +/- ボタン
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.stat-btn');
    if (!btn) return;
    const row = btn.closest('.stat-row');
    const card = btn.closest('.stats-member-card');
    const memberId = card.dataset.memberId;
    const cat = row.dataset.cat;
    const key = row.dataset.key;
    const cur = working[memberId][cat][key] || 0;
    const next = btn.dataset.op === 'inc' ? cur + 1 : Math.max(0, cur - 1);
    working[memberId][cat][key] = next;
    row.querySelector('.stat-value').textContent = next;
    updateSummary(memberId);
  });

  // 勝/負ボタン
  list.querySelectorAll('.decision-buttons').forEach((group) => {
    group.querySelectorAll('.dec-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.stats-member-card');
        const memberId = card.dataset.memberId;
        const val = btn.dataset.dec || null;
        working[memberId].pitching.decision = val;
        group.querySelectorAll('.dec-btn').forEach((b) => {
          b.classList.remove('active-win', 'active-loss', 'active-none');
        });
        if (val === 'win') btn.classList.add('active-win');
        else if (val === 'loss') btn.classList.add('active-loss');
        else btn.classList.add('active-none');
        updateSummary(memberId);
      });
    });
  });

  // クリアボタン
  list.querySelectorAll('.stats-clear-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.stats-member-card');
      const memberId = card.dataset.memberId;
      if (!confirm('この選手の入力をすべてクリアしますか？')) return;
      working[memberId] = emptyPlayerStats();
      // 表示を更新
      card.querySelectorAll('.stat-row').forEach((row) => {
        const cat = row.dataset.cat, key = row.dataset.key;
        if (key === 'decision') {
          row.querySelectorAll('.dec-btn').forEach((b) => {
            b.classList.remove('active-win', 'active-loss', 'active-none');
            if (!b.dataset.dec) b.classList.add('active-none');
          });
        } else {
          row.querySelector('.stat-value').textContent = '0';
        }
      });
      updateSummary(memberId);
    });
  });

  document.getElementById('stats-cancel').addEventListener('click', () => modal.remove());

  document.getElementById('stats-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('stats-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      const playerStats = {};
      for (const memberId of Object.keys(working)) {
        if (!isStatsEmpty(working[memberId])) {
          playerStats[memberId] = working[memberId];
        }
      }
      const updatedGame = { ...game, playerStats };
      const next = {
        ...gamesState,
        games: gamesState.games.map((x) => (x.id === game.id ? updatedGame : x)),
      };
      gamesSha = await writeJSON(
        CONFIG.DATA_PATHS.games,
        next,
        gamesSha,
        `update player stats for game ${game.date} vs ${game.opponent}`
      );
      gamesState = next;
      modal.remove();
      render();
      showToast('選手成績を保存しました', 'success');
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      if (err instanceof ConflictError) {
        showToast(err.message, 'error');
      } else {
        showToast('保存に失敗しました: ' + err.message, 'error');
      }
    }
  });
}

function renderGameCard(g) {
  const result = g.result || (g.ourScore > g.theirScore ? 'win' : g.ourScore < g.theirScore ? 'lose' : 'draw');
  const badge =
    result === 'win'
      ? '<span class="badge badge-win">勝</span>'
      : result === 'lose'
      ? '<span class="badge badge-lose">負</span>'
      : '<span class="badge badge-draw">分</span>';
  const mvpName = g.mvpId
    ? membersState.members.find((m) => m.id === g.mvpId)?.name
    : null;
  const photos = g.photos || [];
  const statsCount = g.playerStats ? Object.keys(g.playerStats).length : 0;
  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="card-meta">${escapeHtml(formatDate(g.date))} ${badge}</div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" data-edit="${g.id}">編集</button>
          <button class="btn btn-sm btn-danger" data-delete="${g.id}">削除</button>
        </div>
      </div>
      ${renderCardScoreboard(g)}
      ${g.location ? `<div class="card-meta">📍 ${escapeHtml(g.location)}</div>` : ''}
      ${mvpName ? `<div class="card-meta">🏆 MVP: ${escapeHtml(mvpName)}</div>` : ''}
      ${g.highlights ? `<p style="margin:8px 0 0;font-size:.9rem;white-space:pre-wrap">${escapeHtml(g.highlights)}</p>` : ''}
      ${photos.length > 0 ? `
        <div class="photo-grid">
          ${photos.map((p, i) => `
            <div class="photo-thumb" data-photo data-game-id="${g.id}" data-photo-index="${i}">
              <img src="${escapeHtml(p)}" alt="" loading="lazy" />
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn btn-sm" data-plays="${g.id}" style="flex:1">
          📝 打席記録${(g.ourPlays || []).length > 0 ? ` (${(g.ourPlays || []).length}打席)` : ''}
        </button>
        <button class="btn btn-sm" data-stats="${g.id}" style="flex:1">
          📊 手動成績${statsCount > 0 ? ` (${statsCount})` : ''}
        </button>
      </div>
    </div>
  `;
}

function openAddDialog() {
  openDialog({
    id: '',
    date: todayISO(),
    opponent: '',
    ourScore: 0,
    theirScore: 0,
    isHome: false,
    innings: [],
    location: '',
    mvpId: '',
    highlights: '',
    photos: [],
  }, false);
}

function openEditDialog(id) {
  const g = gamesState.games.find((x) => x.id === id);
  if (!g) return;
  openDialog({ ...g, photos: [...(g.photos || [])], innings: [...(g.innings || [])] }, true);
}

function openDialog(g, isEdit) {
  const memberOptions = membersState.members
    .map((m) => `<option value="${m.id}" ${m.id === g.mvpId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`)
    .join('');

  const existingPhotos = [...(g.photos || [])];
  const removedPhotos = [];
  const newPhotos = [];

  // イニング別スコアの初期状態
  let innings;
  if (g.innings && g.innings.length > 0) {
    innings = g.innings.map((i) => ({ top: Number(i.top || 0), bottom: Number(i.bottom || 0) }));
  } else if ((g.ourScore || 0) > 0 || (g.theirScore || 0) > 0) {
    // 既存データの移行: 1回に総得点を入れる（その他は0）
    innings = Array.from({ length: 7 }, () => ({ top: 0, bottom: 0 }));
    if (!g.isHome) innings[0] = { top: g.ourScore || 0, bottom: g.theirScore || 0 };
    else innings[0] = { top: g.theirScore || 0, bottom: g.ourScore || 0 };
  } else {
    innings = Array.from({ length: 7 }, () => ({ top: 0, bottom: 0 }));
  }
  let isHome = !!g.isHome;

  const html = `
    <div class="modal-backdrop open" id="game-modal" role="dialog" aria-modal="true">
      <div class="modal">
        <h3>${isEdit ? '試合を編集' : '新しい試合を登録'}</h3>
        <form id="game-form">
          <div class="field">
            <label class="field-label">日付</label>
            <input class="field-input" type="date" name="date" value="${g.date}" required />
          </div>
          <div class="field">
            <label class="field-label">対戦相手</label>
            <input class="field-input" type="text" name="opponent" value="${escapeHtml(g.opponent)}" required />
          </div>
          <div class="field">
            <label class="field-label">スコア（イニング別）</label>
            <div class="home-toggle">
              <span style="font-size:.8rem;color:var(--color-text-muted);margin-right:8px">当チームは</span>
              <button type="button" class="ht-btn" data-home="false">先攻 (表)</button>
              <button type="button" class="ht-btn" data-home="true">後攻 (裏)</button>
            </div>
            <div class="scoreboard-wrapper">
              <div id="scoreboard"></div>
            </div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <button type="button" class="btn btn-sm" id="add-inning">＋ 回</button>
              <button type="button" class="btn btn-sm" id="rem-inning">− 回</button>
            </div>
          </div>
          <div class="field">
            <label class="field-label">場所</label>
            <input class="field-input" type="text" name="location" value="${escapeHtml(g.location)}" placeholder="例: 高井戸第二小学校 校庭" />
          </div>
          <div class="field">
            <label class="field-label">MVP</label>
            <select class="field-select" name="mvpId">
              <option value="">-- 選択しない --</option>
              ${memberOptions}
            </select>
          </div>
          <div class="field">
            <label class="field-label">ハイライト・コメント</label>
            <textarea class="field-textarea" name="highlights" placeholder="活躍した選手や試合のポイント">${escapeHtml(g.highlights)}</textarea>
          </div>

          <div class="field">
            <label class="field-label">写真</label>
            <div id="photo-area">
              <div id="existing-photos" class="photo-grid-edit"></div>
              <div id="new-photos" class="photo-grid-edit"></div>
            </div>
            <input type="file" id="photo-input" accept="image/*" multiple style="display:none" />
            <button type="button" class="btn btn-block btn-sm" id="photo-add-btn" style="margin-top:8px">📷 写真を追加</button>
            <p style="font-size:.75rem;color:var(--color-text-muted);margin:6px 0 0">
              ※ 自動で1280pxにリサイズされます。位置情報(GPS)も削除されます。
            </p>
          </div>

          <div id="upload-progress" style="display:none;margin:12px 0;font-size:.85rem;color:var(--color-text-muted);text-align:center"></div>

          <div class="modal-actions">
            <button type="button" class="btn" id="game-cancel">キャンセル</button>
            <button type="submit" class="btn btn-primary" id="game-submit">${isEdit ? '更新' : '登録'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('game-modal');
  const form = document.getElementById('game-form');
  const submitBtn = document.getElementById('game-submit');
  const photoInput = document.getElementById('photo-input');
  const photoAddBtn = document.getElementById('photo-add-btn');
  const existingEl = document.getElementById('existing-photos');
  const newEl = document.getElementById('new-photos');
  const progressEl = document.getElementById('upload-progress');

  function renderExisting() {
    existingEl.innerHTML = existingPhotos
      .filter((p) => !removedPhotos.includes(p))
      .map((p) => `
        <div class="photo-edit-thumb">
          <img src="${escapeHtml(p)}" alt="" loading="lazy" />
          <button type="button" class="photo-remove-btn" data-remove-existing="${escapeHtml(p)}" title="削除">×</button>
        </div>
      `).join('');
    existingEl.querySelectorAll('[data-remove-existing]').forEach((btn) => {
      btn.addEventListener('click', () => {
        removedPhotos.push(btn.dataset.removeExisting);
        renderExisting();
      });
    });
  }

  function renderNew() {
    newEl.innerHTML = newPhotos.map((entry, i) => `
      <div class="photo-edit-thumb">
        <img src="${entry.previewUrl}" alt="" />
        <button type="button" class="photo-remove-btn" data-remove-new="${i}" title="削除">×</button>
      </div>
    `).join('');
    newEl.querySelectorAll('[data-remove-new]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.removeNew);
        URL.revokeObjectURL(newPhotos[i].previewUrl);
        newPhotos.splice(i, 1);
        renderNew();
      });
    });
  }

  renderExisting();
  renderNew();

  // ----- イニング別スコア -----
  function renderScoreboard() {
    const sb = document.getElementById('scoreboard');
    const headerCells = innings.map((_, i) => `<th>${i + 1}</th>`).join('');
    const topName = isHome ? '相手' : '当ﾁｰﾑ';
    const bottomName = isHome ? '当ﾁｰﾑ' : '相手';
    const topCells = innings.map((inn, i) => `<td><input type="number" min="0" inputmode="numeric" class="inning-cell" data-pos="top" data-i="${i}" value="${inn.top}"></td>`).join('');
    const bottomCells = innings.map((inn, i) => `<td><input type="number" min="0" inputmode="numeric" class="inning-cell" data-pos="bottom" data-i="${i}" value="${inn.bottom}"></td>`).join('');
    const totTop = innings.reduce((s, i) => s + (i.top || 0), 0);
    const totBottom = innings.reduce((s, i) => s + (i.bottom || 0), 0);
    sb.innerHTML = `
      <table class="scoreboard">
        <thead>
          <tr><th></th>${headerCells}<th>計</th></tr>
        </thead>
        <tbody>
          <tr class="${isHome ? '' : 'us-row'}">
            <td>${topName}</td>${topCells}<td class="total" id="total-top">${totTop}</td>
          </tr>
          <tr class="${isHome ? 'us-row' : ''}">
            <td>${bottomName}</td>${bottomCells}<td class="total" id="total-bottom">${totBottom}</td>
          </tr>
        </tbody>
      </table>
    `;
    sb.querySelectorAll('.inning-cell').forEach((input) => {
      input.addEventListener('input', () => {
        const pos = input.dataset.pos;
        const i = Number(input.dataset.i);
        innings[i][pos] = Math.max(0, Number(input.value) || 0);
        document.getElementById('total-top').textContent = innings.reduce((s, x) => s + x.top, 0);
        document.getElementById('total-bottom').textContent = innings.reduce((s, x) => s + x.bottom, 0);
      });
      input.addEventListener('focus', () => input.select());
    });
  }
  renderScoreboard();

  modal.querySelectorAll('.ht-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.home === String(isHome));
    btn.addEventListener('click', () => {
      isHome = btn.dataset.home === 'true';
      modal.querySelectorAll('.ht-btn').forEach((b) => b.classList.toggle('active', b.dataset.home === String(isHome)));
      renderScoreboard();
    });
  });
  document.getElementById('add-inning').addEventListener('click', () => {
    if (innings.length >= 12) return;
    innings.push({ top: 0, bottom: 0 });
    renderScoreboard();
  });
  document.getElementById('rem-inning').addEventListener('click', () => {
    if (innings.length <= 1) return;
    innings.pop();
    renderScoreboard();
  });

  photoAddBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', () => {
    for (const file of photoInput.files) {
      newPhotos.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    photoInput.value = '';
    renderNew();
  });

  document.getElementById('game-cancel').addEventListener('click', () => {
    newPhotos.forEach((n) => URL.revokeObjectURL(n.previewUrl));
    modal.remove();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const totTop = innings.reduce((s, i) => s + (i.top || 0), 0);
    const totBottom = innings.reduce((s, i) => s + (i.bottom || 0), 0);
    const ourScore = isHome ? totBottom : totTop;
    const theirScore = isHome ? totTop : totBottom;
    const gameId = g.id || uid('g');

    submitBtn.disabled = true;
    photoAddBtn.disabled = true;

    const uploadedPaths = [];
    try {
      // 1. アップロード新規写真
      for (let i = 0; i < newPhotos.length; i++) {
        progressEl.style.display = 'block';
        progressEl.textContent = `写真をアップロード中... ${i + 1}/${newPhotos.length}`;
        const blob = await processImage(newPhotos[i].file);
        const base64 = await blobToBase64(blob);
        const ts = Date.now() + i;
        const path = `images/games/${gameId}/${ts}.jpg`;
        await writeBinary(path, base64, `add photo for game ${gameId}`);
        uploadedPaths.push(path);
      }

      // 2. 削除する既存写真をAPIで削除
      for (let i = 0; i < removedPhotos.length; i++) {
        progressEl.style.display = 'block';
        progressEl.textContent = `写真を削除中... ${i + 1}/${removedPhotos.length}`;
        try {
          await deleteFile(removedPhotos[i], null, `remove photo from game ${gameId}`);
        } catch (err) {
          console.warn('photo delete failed', err);
        }
      }

      // 3. games.json 更新
      progressEl.textContent = '保存中...';
      submitBtn.textContent = '保存中...';
      const finalPhotos = [
        ...existingPhotos.filter((p) => !removedPhotos.includes(p)),
        ...uploadedPaths,
      ];
      const newGame = {
        id: gameId,
        date: fd.get('date'),
        opponent: fd.get('opponent').toString().trim(),
        ourScore,
        theirScore,
        result: ourScore > theirScore ? 'win' : ourScore < theirScore ? 'lose' : 'draw',
        isHome,
        innings: innings.map((i) => ({ top: i.top || 0, bottom: i.bottom || 0 })),
        location: fd.get('location').toString().trim(),
        mvpId: fd.get('mvpId').toString() || null,
        highlights: fd.get('highlights').toString().trim(),
        photos: finalPhotos,
        playerStats: g.playerStats || {},
        ourLineup: g.ourLineup || [],
        ourPlays: g.ourPlays || [],
      };

      const next = { ...gamesState };
      if (isEdit) {
        next.games = next.games.map((x) => (x.id === newGame.id ? newGame : x));
      } else {
        next.games = [...next.games, newGame];
      }
      gamesSha = await writeJSON(
        CONFIG.DATA_PATHS.games,
        next,
        gamesSha,
        isEdit ? `update game ${newGame.date} vs ${newGame.opponent}` : `add game ${newGame.date} vs ${newGame.opponent}`
      );
      gamesState = next;
      newPhotos.forEach((n) => URL.revokeObjectURL(n.previewUrl));
      modal.remove();
      render();
      showToast('保存しました', 'success');
    } catch (err) {
      submitBtn.disabled = false;
      photoAddBtn.disabled = false;
      submitBtn.textContent = isEdit ? '更新' : '登録';
      progressEl.style.display = 'none';
      if (err instanceof ConflictError) {
        showToast(err.message, 'error');
      } else {
        showToast('保存に失敗しました: ' + err.message, 'error');
      }
    }
  });
}

async function deleteGame(id) {
  const g = gamesState.games.find((x) => x.id === id);
  if (!g) return;
  const photoCount = (g.photos || []).length;
  const confirmMsg = photoCount > 0
    ? `${formatDate(g.date)} ${g.opponent} 戦を削除しますか？\n（写真 ${photoCount} 枚も一緒に削除されます）`
    : `${formatDate(g.date)} ${g.opponent} 戦を削除しますか？`;
  if (!confirm(confirmMsg)) return;
  try {
    // 写真を削除
    for (const path of g.photos || []) {
      try {
        await deleteFile(path, null, `delete photo (game removed)`);
      } catch (err) {
        console.warn('photo delete failed', err);
      }
    }
    const next = { ...gamesState, games: gamesState.games.filter((x) => x.id !== id) };
    gamesSha = await writeJSON(
      CONFIG.DATA_PATHS.games,
      next,
      gamesSha,
      `delete game ${g.date} vs ${g.opponent}`
    );
    gamesState = next;
    render();
    showToast('削除しました', 'success');
  } catch (err) {
    if (err instanceof ConflictError) {
      showToast(err.message, 'error');
    } else {
      showToast('削除に失敗しました: ' + err.message, 'error');
    }
  }
}

// ========== Lightbox ==========
function openLightbox(photos, startIdx, game) {
  if (!photos || photos.length === 0) return;
  let idx = startIdx;
  const html = `
    <div class="lightbox open" id="lightbox" role="dialog" aria-modal="true">
      <button class="lightbox-close" id="lb-close" aria-label="閉じる">×</button>
      <button class="lightbox-prev" id="lb-prev" aria-label="前へ">‹</button>
      <button class="lightbox-next" id="lb-next" aria-label="次へ">›</button>
      <img class="lightbox-img" id="lb-img" src="${escapeHtml(photos[idx])}" alt="" />
      <div class="lightbox-caption" id="lb-caption"></div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  const cap = document.getElementById('lb-caption');
  const update = () => {
    img.src = photos[idx];
    cap.textContent = `${formatDate(game.date)} vs ${game.opponent} (${idx + 1}/${photos.length})`;
  };
  update();
  document.getElementById('lb-close').addEventListener('click', close);
  document.getElementById('lb-prev').addEventListener('click', () => {
    idx = (idx - 1 + photos.length) % photos.length;
    update();
  });
  document.getElementById('lb-next').addEventListener('click', () => {
    idx = (idx + 1) % photos.length;
    update();
  });
  lb.addEventListener('click', (e) => {
    if (e.target === lb) close();
  });
  function close() { lb.remove(); }
}

// ========== 打席記録モーダル (Phase 2: 打順 + 攻撃 + 守備 + 編集) ==========
function openPlaysDialog(gameId) {
  const game = gamesState.games.find((x) => x.id === gameId);
  if (!game) return;
  if (membersState.members.length === 0) {
    showToast('先にメンバーを登録してください', 'error');
    return;
  }

  // 既存データの正規化（古い文字列配列 → 新しいオブジェクト配列）
  const normalizeLineup = (raw) =>
    (raw || []).map((item) =>
      typeof item === 'string'
        ? { memberId: item, position: '' }
        : { memberId: item.memberId || '', position: item.position || '' }
    );

  let lineup = normalizeLineup(game.ourLineup);
  let plays = (game.ourPlays || []).map((p) => ({ ...p }));
  let oppPlays = (game.oppPlays || []).map((p) => ({ ...p }));
  let activeTab = lineup.length === 0 ? 'lineup' : 'offense';

  // 攻撃タブの状態
  let pendingResult = null;
  let pendingRBI = 0;
  let manualInning = null;
  let offenseEntryCollapsed = false;
  // 守備タブの状態
  let pendingDefResult = null;
  let pendingDefRBI = 0;
  let manualDefInning = null;
  let defenseEntryCollapsed = false;
  let currentPitcherId = oppPlays.length > 0
    ? oppPlays[oppPlays.length - 1].pitcherId
    : null;

  const memberById = (id) => membersState.members.find((m) => m.id === id);

  const html = `
    <div class="modal-backdrop open" id="plays-modal">
      <div class="modal plays-modal">
        <h3 style="margin:0 0 4px">📝 打席記録</h3>
        <div class="card-meta" style="margin-bottom:8px">
          ${escapeHtml(formatDate(game.date))} vs ${escapeHtml(game.opponent || '')}
        </div>
        <div class="play-tabs">
          <button type="button" class="play-tab" data-tab="lineup">打順</button>
          <button type="button" class="play-tab" data-tab="offense">攻撃</button>
          <button type="button" class="play-tab" data-tab="defense">守備</button>
        </div>
        <div class="play-tab-content" id="tab-lineup"></div>
        <div class="play-tab-content" id="tab-offense"></div>
        <div class="play-tab-content" id="tab-defense"></div>
        <div class="modal-actions" style="margin-top:12px">
          <button type="button" class="btn" id="plays-cancel">キャンセル</button>
          <button type="button" class="btn btn-primary" id="plays-save">保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('plays-modal');

  function setTab(tab) {
    activeTab = tab;
    modal.querySelectorAll('.play-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('tab-lineup').style.display = tab === 'lineup' ? 'block' : 'none';
    document.getElementById('tab-offense').style.display = tab === 'offense' ? 'flex' : 'none';
    document.getElementById('tab-defense').style.display = tab === 'defense' ? 'flex' : 'none';
  }
  modal.querySelectorAll('.play-tab').forEach((t) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  // ----- 打順タブ -----
  function renderLineupTab() {
    const positionOptions = (selected) =>
      ['', ...CONFIG.POSITIONS]
        .map((p) => `<option value="${escapeHtml(p)}" ${p === (selected || '') ? 'selected' : ''}>${p || '-- 未選択 --'}</option>`)
        .join('');

    const lineupHtml = lineup.length === 0
      ? '<div class="empty">打順未設定。下から選手を追加してください。</div>'
      : lineup.map((entry, i) => {
        const m = memberById(entry.memberId);
        return `
          <div class="lineup-row" data-pos="${i}">
            <div class="lineup-row-main">
              <span class="lineup-pos">${i + 1}</span>
              <span class="lineup-name">${m ? `${m.number != null ? `<span class="num-badge">#${m.number}</span> ` : ''}${escapeHtml(m.name)}` : '<span style="color:var(--color-danger)">削除済</span>'}</span>
              <div class="lineup-actions">
                <button type="button" class="lineup-icon-btn" data-up ${i === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="lineup-icon-btn" data-down ${i === lineup.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" class="lineup-icon-btn" data-remove>×</button>
              </div>
            </div>
            <div class="lineup-row-position">
              <span class="lineup-pos-label">守備位置</span>
              <select class="lineup-pos-select" data-pos-select="${i}">
                ${positionOptions(entry.position)}
              </select>
            </div>
          </div>
        `;
      }).join('');

    const usedIds = new Set(lineup.map((e) => e.memberId));
    const available = membersState.members.filter((m) => !usedIds.has(m.id));
    const sortedAvail = [...available].sort((a, b) => {
      const na = a.number ?? 999, nb = b.number ?? 999;
      if (na !== nb) return na - nb;
      return (a.name || '').localeCompare(b.name || '', 'ja');
    });

    document.getElementById('tab-lineup').innerHTML = `
      <p style="font-size:.8rem;color:var(--color-text-muted);margin:0 0 8px">
        ↑↓で並び替え、×で削除。10人以上もOK。各打者にポジションを試合ごとに設定できます。
      </p>
      <div class="lineup-list">${lineupHtml}</div>
      ${sortedAvail.length > 0 ? `
        <div style="margin-top:12px">
          <h5 style="margin:0 0 6px;font-size:.85rem;color:var(--color-text-muted)">追加できるメンバー</h5>
          <div class="member-pool">
            ${sortedAvail.map((m) => `
              <button type="button" class="member-pool-btn" data-add-member="${m.id}">
                ${m.number != null ? `<span class="num-badge">#${m.number}</span> ` : ''}${escapeHtml(m.name)}
              </button>
            `).join('')}
          </div>
        </div>
      ` : '<p style="font-size:.8rem;color:var(--color-text-muted);margin-top:8px">全員を打順に入れました。</p>'}
    `;

    const tabEl = document.getElementById('tab-lineup');
    tabEl.querySelectorAll('[data-up]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.closest('.lineup-row').dataset.pos);
        if (i > 0) {
          [lineup[i - 1], lineup[i]] = [lineup[i], lineup[i - 1]];
          renderLineupTab();
        }
      });
    });
    tabEl.querySelectorAll('[data-down]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.closest('.lineup-row').dataset.pos);
        if (i < lineup.length - 1) {
          [lineup[i], lineup[i + 1]] = [lineup[i + 1], lineup[i]];
          renderLineupTab();
        }
      });
    });
    tabEl.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.closest('.lineup-row').dataset.pos);
        const m = memberById(lineup[i].memberId);
        if (!confirm(`「${m ? m.name : '?'}」を打順から外しますか？\n（過去の打席記録は残ります）`)) return;
        lineup.splice(i, 1);
        renderLineupTab();
      });
    });
    tabEl.querySelectorAll('[data-pos-select]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const i = Number(sel.dataset.posSelect);
        lineup[i].position = sel.value;
      });
    });
    tabEl.querySelectorAll('[data-add-member]').forEach((btn) => {
      btn.addEventListener('click', () => {
        lineup.push({ memberId: btn.dataset.addMember, position: '' });
        renderLineupTab();
      });
    });
  }

  // ----- 攻撃タブ -----
  function currentInning() {
    return manualInning != null ? manualInning : computeNextInning(plays);
  }
  function currentBatterIdx() {
    if (lineup.length === 0) return -1;
    return plays.length % lineup.length;
  }
  function renderOffenseTab() {
    const tabEl = document.getElementById('tab-offense');
    if (lineup.length === 0) {
      tabEl.innerHTML = '<div class="empty">先に「打順」タブで打順を設定してください。</div>';
      return;
    }
    const inning = currentInning();
    const outs = outsInInning(plays, inning);
    const inningRuns = runsInInning(plays, inning);
    const batterIdx = currentBatterIdx();
    const entry = lineup[batterIdx];
    const batterId = entry.memberId;
    const batter = memberById(batterId);

    const resultButtons = RESULT_TYPES.map((r) => `
      <button type="button" class="result-btn ${pendingResult === r.key ? 'active' : ''} ${isOut(r.key) ? 'is-out' : 'is-onbase'}" data-result="${r.key}">
        ${r.label}
      </button>
    `).join('');

    const recentPlays = [...plays].reverse().slice(0, 30);
    const playsList = plays.length === 0
      ? '<div class="card-meta" style="text-align:center;padding:12px">まだ打席が記録されていません</div>'
      : recentPlays.map((p, idxRev) => {
        const realIdx = plays.length - 1 - idxRev;
        const m = memberById(p.batterId);
        return `
          <div class="play-row">
            <span class="play-inning">${p.inning}回</span>
            <span class="play-batter">${m ? (m.number != null ? `#${m.number} ` : '') + m.name : '?'}</span>
            <span class="play-result">${resultLabel(p.result)}${p.rbi > 0 ? ` <strong>(${p.rbi}打点)</strong>` : ''}</span>
            <button type="button" class="play-edit-btn" data-play-edit="${realIdx}" aria-label="編集">編</button>
            <button type="button" class="play-del-btn" data-play-del="${realIdx}" aria-label="削除">×</button>
          </div>
        `;
      }).join('');

    tabEl.innerHTML = `
      <button type="button" class="entry-toggle" id="entry-toggle">
        ${offenseEntryCollapsed ? `▼ 入力エリアを開く（${inning}回・${batterIdx + 1}番 ${batter ? batter.name : '?'}）` : '▲ 入力エリアを閉じて履歴を広げる'}
      </button>
      <div class="play-entry ${offenseEntryCollapsed ? 'collapsed' : ''}">
        <div class="play-state">
          <div class="play-state-row">
            <span class="play-state-label">${inning}回</span>
            <span class="play-state-out">アウト ${outs}/3</span>
            <span class="play-state-runs">この回 ${inningRuns}点</span>
          </div>
          <div class="play-state-row" style="margin-top:6px">
            <button type="button" class="btn btn-sm" id="prev-inning">前の回</button>
            <button type="button" class="btn btn-sm" id="next-inning">次の回</button>
            ${manualInning != null ? '<span style="font-size:.7rem;color:var(--color-warning);margin-left:8px">手動指定中</span>' : ''}
          </div>
        </div>
        <div class="batter-info">
          <span style="font-size:.8rem;color:var(--color-text-muted)">打者</span>
          <strong>${batterIdx + 1}番: ${batter ? (batter.number != null ? `<span class="num-badge">#${batter.number}</span> ` : '') + escapeHtml(batter.name) : '?'}${entry.position ? ` <span style="font-size:.8rem;color:var(--color-text-muted);font-weight:normal">(${escapeHtml(entry.position)})</span>` : ''}</strong>
        </div>
        <div class="result-grid">${resultButtons}</div>
        <div class="entry-bottom-bar">
          <div class="rbi-controls" style="flex:1;margin:0">
            <span class="stat-label">打点</span>
            <div class="stat-controls">
              <button type="button" class="stat-btn" id="rbi-dec">−</button>
              <span class="stat-value" id="rbi-display">${pendingRBI}</span>
              <button type="button" class="stat-btn stat-btn-plus" id="rbi-inc">+</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary" id="confirm-pa" ${!pendingResult ? 'disabled' : ''} style="flex:1">
            記録 ▶
          </button>
        </div>
      </div>
      <h5 class="plays-list-title">記録済みの打席 (${plays.length})</h5>
      <div class="plays-list-scroll">
        <div class="plays-list">${playsList}</div>
      </div>
    `;
    document.getElementById('entry-toggle').addEventListener('click', () => {
      offenseEntryCollapsed = !offenseEntryCollapsed;
      renderOffenseTab();
    });

    tabEl.querySelectorAll('.result-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.result;
        pendingResult = pendingResult === r ? null : r;
        renderOffenseTab();
      });
    });
    document.getElementById('rbi-dec').addEventListener('click', () => {
      pendingRBI = Math.max(0, pendingRBI - 1);
      document.getElementById('rbi-display').textContent = pendingRBI;
    });
    document.getElementById('rbi-inc').addEventListener('click', () => {
      pendingRBI = Math.min(4, pendingRBI + 1);
      document.getElementById('rbi-display').textContent = pendingRBI;
    });
    document.getElementById('confirm-pa').addEventListener('click', () => {
      if (!pendingResult) return;
      plays.push({
        inning: currentInning(),
        batterId,
        result: pendingResult,
        rbi: pendingRBI,
      });
      pendingResult = null;
      pendingRBI = 0;
      manualInning = null;
      renderOffenseTab();
    });
    document.getElementById('prev-inning').addEventListener('click', () => {
      const cur = currentInning();
      if (cur > 1) manualInning = cur - 1;
      renderOffenseTab();
    });
    document.getElementById('next-inning').addEventListener('click', () => {
      manualInning = currentInning() + 1;
      renderOffenseTab();
    });
    tabEl.querySelectorAll('[data-play-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.playDel);
        const p = plays[idx];
        const m = memberById(p.batterId);
        if (!confirm(`${p.inning}回 ${m ? m.name : '?'} の打席を削除しますか？`)) return;
        plays.splice(idx, 1);
        renderOffenseTab();
      });
    });
    tabEl.querySelectorAll('[data-play-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.playEdit);
        openPlayEditPopup({
          play: plays[idx],
          isOffense: true,
          onSave: (updated) => {
            plays[idx] = updated;
            renderOffenseTab();
          },
        });
      });
    });
  }

  // ----- 守備タブ -----
  function currentDefInning() {
    return manualDefInning != null ? manualDefInning : computeNextInning(oppPlays);
  }
  function renderDefenseTab() {
    const tabEl = document.getElementById('tab-defense');
    const inning = currentDefInning();
    const outs = outsInInning(oppPlays, inning);
    const inningRuns = runsInInning(oppPlays, inning);
    const pitcher = currentPitcherId ? memberById(currentPitcherId) : null;

    const resultButtons = RESULT_TYPES.map((r) => `
      <button type="button" class="result-btn ${pendingDefResult === r.key ? 'active' : ''} ${isOut(r.key) ? 'is-out' : 'is-onbase'}" data-def-result="${r.key}">
        ${r.label}
      </button>
    `).join('');

    const recentPlays = [...oppPlays].reverse().slice(0, 30);
    const playsList = oppPlays.length === 0
      ? '<div class="card-meta" style="text-align:center;padding:12px">まだ打席が記録されていません</div>'
      : recentPlays.map((p, idxRev) => {
        const realIdx = oppPlays.length - 1 - idxRev;
        const pm = p.pitcherId ? memberById(p.pitcherId) : null;
        return `
          <div class="play-row">
            <span class="play-inning">${p.inning}回</span>
            <span class="play-batter">${pm ? (pm.number != null ? `#${pm.number} ` : '') + pm.name : '<span style="color:var(--color-text-muted)">投手未設定</span>'}</span>
            <span class="play-result">${resultLabel(p.result)}${p.rbi > 0 ? ` <strong>(${p.rbi}失点)</strong>` : ''}</span>
            <button type="button" class="play-edit-btn" data-defplay-edit="${realIdx}" aria-label="編集">編</button>
            <button type="button" class="play-del-btn" data-defplay-del="${realIdx}" aria-label="削除">×</button>
          </div>
        `;
      }).join('');

    tabEl.innerHTML = `
      <button type="button" class="entry-toggle" id="def-entry-toggle">
        ${defenseEntryCollapsed ? `▼ 入力エリアを開く（${inning}回・投手:${pitcher ? pitcher.name : '未設定'}）` : '▲ 入力エリアを閉じて履歴を広げる'}
      </button>
      <div class="play-entry ${defenseEntryCollapsed ? 'collapsed' : ''}">
        <div class="play-state">
          <div class="play-state-row">
            <span class="play-state-label">${inning}回</span>
            <span class="play-state-out">アウト ${outs}/3</span>
            <span class="play-state-runs" style="color:var(--color-danger)">失点 ${inningRuns}</span>
          </div>
          <div class="play-state-row" style="margin-top:6px">
            <button type="button" class="btn btn-sm" id="def-prev-inning">前の回</button>
            <button type="button" class="btn btn-sm" id="def-next-inning">次の回</button>
            ${manualDefInning != null ? '<span style="font-size:.7rem;color:var(--color-warning);margin-left:8px">手動指定中</span>' : ''}
          </div>
        </div>
        <div class="batter-info">
          <span style="font-size:.8rem;color:var(--color-text-muted)">投手</span>
          ${pitcher
            ? `<strong>${pitcher.number != null ? `<span class="num-badge">#${pitcher.number}</span> ` : ''}${escapeHtml(pitcher.name)}</strong>`
            : '<strong style="color:var(--color-warning)">未設定</strong>'}
          <button type="button" class="btn btn-sm" id="change-pitcher" style="margin-left:auto">変更</button>
        </div>
        <div class="result-grid">${resultButtons}</div>
        <div class="entry-bottom-bar">
          <div class="rbi-controls" style="flex:1;margin:0">
            <span class="stat-label">失点</span>
            <div class="stat-controls">
              <button type="button" class="stat-btn" id="def-rbi-dec">−</button>
              <span class="stat-value" id="def-rbi-display">${pendingDefRBI}</span>
              <button type="button" class="stat-btn stat-btn-plus" id="def-rbi-inc">+</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary" id="confirm-def-pa" ${!pendingDefResult ? 'disabled' : ''} style="flex:1">
            記録 ▶
          </button>
        </div>
      </div>
      <h5 class="plays-list-title">記録済みの打席 (${oppPlays.length})</h5>
      <div class="plays-list-scroll">
        <div class="plays-list">${playsList}</div>
      </div>
    `;
    document.getElementById('def-entry-toggle').addEventListener('click', () => {
      defenseEntryCollapsed = !defenseEntryCollapsed;
      renderDefenseTab();
    });

    tabEl.querySelectorAll('.result-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.defResult;
        pendingDefResult = pendingDefResult === r ? null : r;
        renderDefenseTab();
      });
    });
    document.getElementById('def-rbi-dec').addEventListener('click', () => {
      pendingDefRBI = Math.max(0, pendingDefRBI - 1);
      document.getElementById('def-rbi-display').textContent = pendingDefRBI;
    });
    document.getElementById('def-rbi-inc').addEventListener('click', () => {
      pendingDefRBI = Math.min(4, pendingDefRBI + 1);
      document.getElementById('def-rbi-display').textContent = pendingDefRBI;
    });
    document.getElementById('confirm-def-pa').addEventListener('click', () => {
      if (!pendingDefResult) return;
      oppPlays.push({
        inning: currentDefInning(),
        result: pendingDefResult,
        rbi: pendingDefRBI,
        pitcherId: currentPitcherId || null,
      });
      pendingDefResult = null;
      pendingDefRBI = 0;
      manualDefInning = null;
      renderDefenseTab();
    });
    document.getElementById('def-prev-inning').addEventListener('click', () => {
      const cur = currentDefInning();
      if (cur > 1) manualDefInning = cur - 1;
      renderDefenseTab();
    });
    document.getElementById('def-next-inning').addEventListener('click', () => {
      manualDefInning = currentDefInning() + 1;
      renderDefenseTab();
    });
    document.getElementById('change-pitcher').addEventListener('click', () => {
      openPitcherPicker((picked) => {
        currentPitcherId = picked;
        renderDefenseTab();
      });
    });
    tabEl.querySelectorAll('[data-defplay-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.defplayDel);
        const p = oppPlays[idx];
        if (!confirm(`${p.inning}回 相手の打席（${resultLabel(p.result)}）を削除しますか？`)) return;
        oppPlays.splice(idx, 1);
        renderDefenseTab();
      });
    });
    tabEl.querySelectorAll('[data-defplay-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.defplayEdit);
        openPlayEditPopup({
          play: oppPlays[idx],
          isOffense: false,
          onSave: (updated) => {
            oppPlays[idx] = updated;
            renderDefenseTab();
          },
        });
      });
    });
  }

  // ----- 投手選択ポップアップ -----
  function openPitcherPicker(onPick) {
    const sortedMembers = [...membersState.members].sort((a, b) => {
      const na = a.number ?? 999, nb = b.number ?? 999;
      if (na !== nb) return na - nb;
      return (a.name || '').localeCompare(b.name || '', 'ja');
    });
    const html = `
      <div class="play-edit-popup-backdrop" id="pitcher-picker">
        <div class="play-edit-popup">
          <h4>投手を選択</h4>
          <div class="member-pool" style="max-height:300px;overflow:auto;display:flex;flex-direction:column">
            <button type="button" class="member-pool-btn ${!currentPitcherId ? 'active' : ''}" data-pick="">-- 投手なし --</button>
            ${sortedMembers.map((m) => `
              <button type="button" class="member-pool-btn ${m.id === currentPitcherId ? 'active' : ''}" data-pick="${m.id}">
                ${m.number != null ? `<span class="num-badge">#${m.number}</span> ` : ''}${escapeHtml(m.name)}
              </button>
            `).join('')}
          </div>
          <div class="modal-actions" style="margin-top:12px">
            <button type="button" class="btn btn-block" id="pitcher-picker-cancel">キャンセル</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('pitcher-picker');
    backdrop.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onPick(btn.dataset.pick || null);
        backdrop.remove();
      });
    });
    document.getElementById('pitcher-picker-cancel').addEventListener('click', () => backdrop.remove());
  }

  // ----- 打席編集ポップアップ -----
  function openPlayEditPopup({ play, isOffense, onSave }) {
    let editResult = play.result;
    let editRBI = play.rbi || 0;
    let editInning = play.inning;
    let editBatterId = play.batterId;
    let editPitcherId = play.pitcherId || null;

    const memberOptions = (selected) =>
      membersState.members.map((m) => `
        <option value="${m.id}" ${m.id === selected ? 'selected' : ''}>
          ${m.number != null ? `#${m.number} ` : ''}${escapeHtml(m.name)}
        </option>
      `).join('');

    const html = `
      <div class="play-edit-popup-backdrop" id="play-edit-backdrop">
        <div class="play-edit-popup">
          <h4>${isOffense ? '打席を編集' : '相手打席を編集'}</h4>
          <div class="field" style="display:flex;align-items:center;gap:8px">
            <label class="field-label" style="margin:0;min-width:60px">イニング</label>
            <input class="field-input" type="number" min="1" id="edit-inning" value="${editInning}" style="max-width:80px">
            <span style="font-size:.85rem;color:var(--color-text-muted)">回</span>
          </div>
          ${isOffense ? `
            <div class="field">
              <label class="field-label">打者</label>
              <select class="field-select" id="edit-batter">
                ${memberOptions(editBatterId)}
              </select>
            </div>
          ` : `
            <div class="field">
              <label class="field-label">投手</label>
              <select class="field-select" id="edit-pitcher">
                <option value="">-- なし --</option>
                ${memberOptions(editPitcherId)}
              </select>
            </div>
          `}
          <div class="field">
            <label class="field-label">結果</label>
            <div class="result-grid">
              ${RESULT_TYPES.map((r) => `
                <button type="button" class="result-btn ${r.key === editResult ? 'active' : ''} ${isOut(r.key) ? 'is-out' : 'is-onbase'}" data-edit-result="${r.key}">
                  ${r.label}
                </button>
              `).join('')}
            </div>
          </div>
          <div class="rbi-controls">
            <span class="stat-label">${isOffense ? '打点' : '失点'}</span>
            <div class="stat-controls">
              <button type="button" class="stat-btn" id="edit-rbi-dec">−</button>
              <span class="stat-value" id="edit-rbi-display">${editRBI}</span>
              <button type="button" class="stat-btn stat-btn-plus" id="edit-rbi-inc">+</button>
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" id="edit-cancel">キャンセル</button>
            <button type="button" class="btn btn-primary" id="edit-save">更新</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    const backdrop = document.getElementById('play-edit-backdrop');

    backdrop.querySelectorAll('[data-edit-result]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editResult = btn.dataset.editResult;
        backdrop.querySelectorAll('[data-edit-result]').forEach((b) => b.classList.toggle('active', b.dataset.editResult === editResult));
      });
    });
    document.getElementById('edit-rbi-dec').addEventListener('click', () => {
      editRBI = Math.max(0, editRBI - 1);
      document.getElementById('edit-rbi-display').textContent = editRBI;
    });
    document.getElementById('edit-rbi-inc').addEventListener('click', () => {
      editRBI = Math.min(4, editRBI + 1);
      document.getElementById('edit-rbi-display').textContent = editRBI;
    });
    document.getElementById('edit-cancel').addEventListener('click', () => backdrop.remove());
    document.getElementById('edit-save').addEventListener('click', () => {
      const inningRaw = Number(document.getElementById('edit-inning').value) || 1;
      editInning = Math.max(1, inningRaw);
      let updated;
      if (isOffense) {
        editBatterId = document.getElementById('edit-batter').value;
        updated = { ...play, inning: editInning, batterId: editBatterId, result: editResult, rbi: editRBI };
      } else {
        editPitcherId = document.getElementById('edit-pitcher').value || null;
        updated = { ...play, inning: editInning, pitcherId: editPitcherId, result: editResult, rbi: editRBI };
      }
      onSave(updated);
      backdrop.remove();
    });
  }

  setTab(activeTab);
  renderLineupTab();
  renderOffenseTab();
  renderDefenseTab();

  document.getElementById('plays-cancel').addEventListener('click', () => modal.remove());
  document.getElementById('plays-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('plays-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    try {
      let updatedGame = {
        ...game,
        ourLineup: lineup,
        ourPlays: plays,
        oppPlays: oppPlays,
      };
      // スコア再計算（plays/oppPlays から打点合計）
      if (plays.length > 0 || oppPlays.length > 0) {
        const ourTotal = plays.reduce((s, p) => s + (p.rbi || 0), 0);
        const theirTotal = oppPlays.reduce((s, p) => s + (p.rbi || 0), 0);
        if (plays.length > 0) updatedGame.ourScore = ourTotal;
        if (oppPlays.length > 0) updatedGame.theirScore = theirTotal;
        const our = updatedGame.ourScore || 0;
        const their = updatedGame.theirScore || 0;
        updatedGame.result = our > their ? 'win' : our < their ? 'lose' : 'draw';
      }
      const next = {
        ...gamesState,
        games: gamesState.games.map((x) => (x.id === game.id ? updatedGame : x)),
      };
      gamesSha = await writeJSON(
        CONFIG.DATA_PATHS.games,
        next,
        gamesSha,
        `update plays for game ${game.date} vs ${game.opponent}`,
      );
      gamesState = next;
      modal.remove();
      render();
      showToast('打席記録を保存しました', 'success');
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
      if (err instanceof ConflictError) showToast(err.message, 'error');
      else showToast('保存に失敗しました: ' + err.message, 'error');
    }
  });
}
