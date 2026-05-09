import { CONFIG } from '../config.js';
import { fetchJSON, writeJSON, ConflictError } from '../api.js';
import { renderHeader, renderNav, requireAuth, showToast, escapeHtml, uid } from '../app.js';
import { aggregateBattingFromPlays, HIT_RESULTS } from '../plays.js';

renderHeader();
renderNav('members');

let membersState = { members: [] };
let membersSha = null;
let gamesState = { games: [] };

requireAuth(async () => {
  await Promise.all([loadMembers(), loadGames()]);
  render();
  document.getElementById('add-member-btn').addEventListener('click', openAddDialog);
});

async function loadMembers() {
  const { data, sha } = await fetchJSON(CONFIG.DATA_PATHS.members);
  membersState = data || { members: [] };
  membersSha = sha;
}

async function loadGames() {
  const { data } = await fetchJSON(CONFIG.DATA_PATHS.games);
  gamesState = data || { games: [] };
}

const PITCHING_KEYS = ['strikeouts', 'walks', 'hitBatters', 'errors', 'hitsAllowed'];

function aggregateStats(memberId) {
  const r = {
    plateAppearances: 0, atBats: 0, hits: 0,
    singles: 0, doubles: 0, triples: 0, homeRuns: 0,
    walksBatter: 0, hbpBatter: 0,
    rbis: 0, strikeouts: 0, flyOuts: 0, groundOuts: 0, reachedOnError: 0,
    otherOuts: 0, otherSafes: 0,
    pitchGames: 0, wins: 0, losses: 0,
    pitchStrikeouts: 0, walks: 0, hitBatters: 0, errors: 0, hitsAllowed: 0,
  };
  for (const game of gamesState.games) {
    // 打席記録 (ourPlays) を最優先で集計
    if (game.ourPlays && game.ourPlays.length > 0) {
      const playStats = aggregateBattingFromPlays(memberId, game.ourPlays);
      r.singles += playStats.singles;
      r.doubles += playStats.doubles;
      r.triples += playStats.triples;
      r.homeRuns += playStats.homeRuns;
      r.walksBatter += playStats.walks;
      r.hbpBatter += playStats.hbp;
      r.strikeouts += playStats.strikeouts;
      r.flyOuts += playStats.flyOuts;
      r.groundOuts += playStats.groundOuts;
      r.reachedOnError += playStats.reachedOnError;
      r.otherOuts += playStats.otherOuts;
      r.otherSafes += playStats.otherSafes;
      r.rbis += playStats.rbis;
    } else {
      // 旧方式 (playerStats) を集計
      const ps = game.playerStats && game.playerStats[memberId];
      if (ps && ps.batting) {
        const b = ps.batting;
        r.singles += b.singles || 0;
        r.doubles += b.doubles || 0;
        r.triples += b.triples || 0;
        r.homeRuns += b.homeRuns || 0;
        r.rbis += b.rbis || 0;
        r.strikeouts += b.strikeouts || 0;
        r.flyOuts += b.flyOuts || 0;
        r.groundOuts += b.groundOuts || 0;
        r.reachedOnError += b.reachedOnError || 0;
      }
    }
    // 投手成績: 守備の打席記録 (oppPlays) があれば自動集計、なければ旧方式
    const ps = game.playerStats && game.playerStats[memberId];
    if (game.oppPlays && game.oppPlays.length > 0) {
      const myOppPAs = game.oppPlays.filter((p) => p.pitcherId === memberId);
      if (myOppPAs.length > 0) {
        r.pitchGames++;
        for (const p of myOppPAs) {
          if (p.result === 'strikeout') r.pitchStrikeouts++;
          else if (p.result === 'walk') r.walks++;
          else if (p.result === 'hbp') r.hitBatters++;
          else if (HIT_RESULTS.includes(p.result)) r.hitsAllowed++;
          else if (p.result === 'reachedOnError') r.errors++;
          // otherOut/otherSafe は特別なカウントなし
          r.runsAllowed = (r.runsAllowed || 0) + (p.rbi || 0);
        }
      }
    } else if (ps && ps.pitching) {
      const p = ps.pitching;
      const hasPitching = !!p.decision || PITCHING_KEYS.some((k) => (p[k] || 0) > 0);
      if (hasPitching) r.pitchGames++;
      r.pitchStrikeouts += p.strikeouts || 0;
      r.walks += p.walks || 0;
      r.hitBatters += p.hitBatters || 0;
      r.errors += p.errors || 0;
      r.hitsAllowed += p.hitsAllowed || 0;
    }

    // 勝/負を判定
    // 1. 手動入力 (📊 手動成績の decision) を優先
    // 2. なければ oppPlays から自動推定:
    //    - 試合に勝敗がある (ourScore != theirScore)
    //    - そのメンバーが「最も多くの相手打者と対戦した投手」
    //    - 試合は finalized 済 OR データが揃っている場合
    let decision = null;
    if (ps && ps.pitching && ps.pitching.decision) {
      decision = ps.pitching.decision;
    }
    if (!decision && game.oppPlays && game.oppPlays.length > 0) {
      const pitcherCounts = {};
      for (const p of game.oppPlays) {
        if (p.pitcherId) {
          pitcherCounts[p.pitcherId] = (pitcherCounts[p.pitcherId] || 0) + 1;
        }
      }
      const sorted = Object.entries(pitcherCounts).sort((a, b) => b[1] - a[1]);
      const topPitcherId = sorted.length > 0 ? sorted[0][0] : null;
      if (topPitcherId === memberId) {
        const our = game.ourScore || 0;
        const their = game.theirScore || 0;
        if (our > their) decision = 'win';
        else if (our < their) decision = 'loss';
      }
    }
    if (decision === 'win') r.wins++;
    if (decision === 'loss') r.losses++;
  }
  if (r.runsAllowed === undefined) r.runsAllowed = 0;
  r.hits = r.singles + r.doubles + r.triples + r.homeRuns;
  r.plateAppearances = r.hits + r.walksBatter + r.hbpBatter + r.strikeouts + r.flyOuts + r.groundOuts + r.reachedOnError + r.otherOuts + r.otherSafes;
  r.atBats = r.plateAppearances - r.walksBatter - r.hbpBatter;
  return r;
}

function formatBattingAvg(hits, ab) {
  if (ab === 0) return '.---';
  const avg = hits / ab;
  return avg.toFixed(3).replace(/^0+/, '');
}

const SORT_OPTIONS = [
  { key: 'number_asc', label: '背番号順', cmp: (a, b) => (a.number ?? 999) - (b.number ?? 999) || (a.name || '').localeCompare(b.name || '', 'ja'), highlight: null },
  { key: 'name_asc', label: '名前順', cmp: (a, b) => (a.name || '').localeCompare(b.name || '', 'ja'), highlight: null },
  { key: 'avg_desc', label: '打率（高い順）', cmp: (a, b) => (b._avg ?? 0) - (a._avg ?? 0) || b._stats.atBats - a._stats.atBats, highlight: 'avg' },
  { key: 'pa_desc', label: '打席（多い順）', cmp: (a, b) => b._stats.plateAppearances - a._stats.plateAppearances, highlight: 'pa' },
  { key: 'ab_desc', label: '打数（多い順）', cmp: (a, b) => b._stats.atBats - a._stats.atBats, highlight: 'ab' },
  { key: 'hits_desc', label: '安打（多い順）', cmp: (a, b) => b._stats.hits - a._stats.hits, highlight: 'hits' },
  { key: 'hr_desc', label: '本塁打（多い順）', cmp: (a, b) => b._stats.homeRuns - a._stats.homeRuns, highlight: 'hr' },
  { key: 'rbi_desc', label: '打点（多い順）', cmp: (a, b) => b._stats.rbis - a._stats.rbis, highlight: 'rbi' },
  { key: 'mvp_desc', label: 'MVP回数（多い順）', cmp: (a, b) => b._mvp - a._mvp, highlight: 'mvp' },
  { key: 'wins_desc', label: '勝（多い順）', cmp: (a, b) => b._stats.wins - a._stats.wins, highlight: 'wins' },
  { key: 'pitchK_desc', label: '奪三振（多い順）', cmp: (a, b) => b._stats.pitchStrikeouts - a._stats.pitchStrikeouts, highlight: 'pitchK' },
];

let currentSortKey = localStorage.getItem('members_sort_key') || 'name_asc';

function getCurrentSortOption() {
  return SORT_OPTIONS.find((o) => o.key === currentSortKey) || SORT_OPTIONS[0];
}

function ensureSortControl() {
  if (document.getElementById('member-sort')) return;
  const container = document.querySelector('.app-main .action-bar');
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap';
  wrap.innerHTML = `
    <span style="font-size:.8rem;color:var(--color-text-muted)">並び替え:</span>
    <select id="member-sort" class="field-select" style="flex:1;min-width:180px;max-width:240px;font-size:.85rem;padding:6px 8px">
      ${SORT_OPTIONS.map((o) => `<option value="${o.key}" ${o.key === currentSortKey ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select>
  `;
  container.parentNode.insertBefore(wrap, container);
  document.getElementById('member-sort').addEventListener('change', (e) => {
    currentSortKey = e.target.value;
    localStorage.setItem('members_sort_key', currentSortKey);
    render();
  });
}

function render() {
  ensureSortControl();
  const list = document.getElementById('members-list');
  const enriched = membersState.members.map((m) => {
    const stats = aggregateStats(m.id);
    const avg = stats.atBats > 0 ? stats.hits / stats.atBats : 0;
    const mvp = gamesState.games.filter((g) => g.mvpId === m.id).length;
    return { ...m, _stats: stats, _avg: avg, _mvp: mvp };
  });
  const sortOpt = getCurrentSortOption();
  const members = [...enriched].sort(sortOpt.cmp);

  if (members.length === 0) {
    list.innerHTML = '<div class="empty">まだメンバーが登録されていません。<br>「＋ 新規登録」から登録してください。</div>';
    return;
  }
  const showRank = sortOpt.highlight != null;
  list.innerHTML = members.map((m, idx) => renderMemberCard(m, sortOpt.highlight, showRank ? idx + 1 : null)).join('');
  list.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => openDetailDialog(btn.dataset.detail));
  });
  list.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditDialog(btn.dataset.edit);
    });
  });
  list.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMember(btn.dataset.delete);
    });
  });
}

function renderMemberCard(m, highlight, rank) {
  const mvpCount = m._mvp;
  const stats = m._stats;
  const avg = formatBattingAvg(stats.hits, stats.atBats);
  const summary = stats.plateAppearances > 0
    ? `打率${avg} (${stats.hits}/${stats.atBats}) ・ 本塁打${stats.homeRuns} ・ 打点${stats.rbis}`
    : '記録なし';

  const highlightValueMap = {
    avg, pa: stats.plateAppearances, ab: stats.atBats, hits: stats.hits,
    hr: stats.homeRuns, rbi: stats.rbis, mvp: mvpCount,
    wins: stats.wins, pitchK: stats.pitchStrikeouts,
  };
  const highlightLabelMap = {
    avg: '打率', pa: '打席', ab: '打数', hits: '安打',
    hr: '本塁打', rbi: '打点', mvp: 'MVP',
    wins: '勝', pitchK: '奪三振',
  };
  const highlightValue = highlight != null ? highlightValueMap[highlight] : null;
  const highlightLabel = highlight != null ? highlightLabelMap[highlight] : null;
  const rankBadge = rank != null
    ? `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;border-radius:50%;background:${rank <= 3 ? 'var(--color-accent)' : '#eef4fb'};color:${rank <= 3 ? '#fff' : 'var(--color-primary)'};font-weight:700;font-size:.85rem;flex-shrink:0">${rank}</span>`
    : '';

  return `
    <div class="card" style="cursor:pointer" data-detail="${m.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        ${rankBadge}
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            ${m.number != null ? `<span style="background:var(--color-primary);color:#fff;padding:2px 8px;border-radius:12px;font-size:.8rem;font-weight:600">#${m.number}</span>` : ''}
            <span class="card-title" style="margin:0">${escapeHtml(m.name)}</span>
            ${highlight != null && highlightValue !== '' ? `<span style="margin-left:auto;background:var(--color-accent);color:#fff;padding:2px 10px;border-radius:12px;font-size:.85rem;font-weight:700">${highlightLabel} ${highlightValue}</span>` : ''}
          </div>
          <div class="card-meta">
            ${mvpCount > 0 ? `🏆 MVP ${mvpCount}回` : '—'}
          </div>
          <div class="card-meta" style="margin-top:4px">${summary}</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn btn-sm" data-edit="${m.id}">編集</button>
          <button class="btn btn-sm btn-danger" data-delete="${m.id}">削除</button>
        </div>
      </div>
    </div>
  `;
}

function openDetailDialog(id) {
  const m = membersState.members.find((x) => x.id === id);
  if (!m) return;
  const myMvpGames = gamesState.games
    .filter((g) => g.mvpId === id)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const myStatGames = gamesState.games
    .filter((g) => g.playerStats && g.playerStats[id])
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const s = aggregateStats(m.id);
  const avg = formatBattingAvg(s.hits, s.atBats);

  const html = `
    <div class="modal-backdrop open" id="detail-modal" role="dialog" aria-modal="true">
      <div class="modal" style="max-width:520px">
        <h3>${m.number != null ? `#${m.number} ` : ''}${escapeHtml(m.name)}</h3>

        <h4 style="margin:16px 0 8px;font-size:.95rem;color:var(--color-primary)">打撃成績 <span style="color:var(--color-text-muted);font-weight:normal;font-size:.8rem">（試合記録から自動集計）</span></h4>
        ${s.plateAppearances === 0 ? `<div class="card-meta">まだ記録がありません</div>` : `
        <table class="stats-table">
          <tr><td>打率</td><td>${avg}</td><td>打席</td><td>${s.plateAppearances}</td></tr>
          <tr><td>打数</td><td>${s.atBats}</td><td>安打</td><td>${s.hits}</td></tr>
          <tr><td>打点</td><td>${s.rbis}</td><td>本塁打</td><td>${s.homeRuns}</td></tr>
          <tr><td>三塁打</td><td>${s.triples}</td><td>二塁打</td><td>${s.doubles}</td></tr>
          <tr><td>単打</td><td>${s.singles}</td><td>失策出塁</td><td>${s.reachedOnError}</td></tr>
          <tr><td>四球</td><td>${s.walksBatter}</td><td>死球</td><td>${s.hbpBatter}</td></tr>
          <tr><td>三振</td><td>${s.strikeouts}</td><td>飛/ゴロ</td><td>${s.flyOuts}/${s.groundOuts}</td></tr>
          <tr><td>他セーフ</td><td>${s.otherSafes}</td><td>他アウト</td><td>${s.otherOuts}</td></tr>
        </table>
        `}

        ${s.pitchGames > 0 ? `
        <h4 style="margin:16px 0 8px;font-size:.95rem;color:var(--color-primary)">投手成績 <span style="color:var(--color-text-muted);font-weight:normal;font-size:.8rem">（守備の打席記録から自動集計）</span></h4>
        <table class="stats-table">
          <tr><td>登板</td><td>${s.pitchGames}</td><td>勝-敗</td><td>${s.wins}-${s.losses}</td></tr>
          <tr><td>奪三振</td><td>${s.pitchStrikeouts}</td><td>被安打</td><td>${s.hitsAllowed}</td></tr>
          <tr><td>与四球</td><td>${s.walks}</td><td>与死球</td><td>${s.hitBatters}</td></tr>
          <tr><td>失点</td><td>${s.runsAllowed}</td><td>失策出塁</td><td>${s.errors}</td></tr>
        </table>
        ` : ''}

        <h4 style="margin:16px 0 8px;font-size:.95rem;color:var(--color-primary)">MVP獲得試合 (${myMvpGames.length})</h4>
        ${myMvpGames.length === 0
          ? '<div class="card-meta">まだありません</div>'
          : myMvpGames.map(g => `<div class="card-meta">・ ${escapeHtml(g.date)} vs ${escapeHtml(g.opponent)}</div>`).join('')}

        ${myStatGames.length > 0 ? `
        <h4 style="margin:16px 0 8px;font-size:.95rem;color:var(--color-primary)">出場記録 (${myStatGames.length}試合)</h4>
        ${myStatGames.map(g => `<div class="card-meta">・ ${escapeHtml(g.date)} vs ${escapeHtml(g.opponent)}</div>`).join('')}
        ` : ''}

        ${m.notes ? `<h4 style="margin:16px 0 8px;font-size:.95rem;color:var(--color-primary)">メモ</h4><p style="margin:0;white-space:pre-wrap;font-size:.9rem">${escapeHtml(m.notes)}</p>` : ''}

        <div class="modal-actions">
          <button type="button" class="btn btn-block" id="detail-close">閉じる</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('detail-close').addEventListener('click', () => {
    document.getElementById('detail-modal').remove();
  });
}

function openAddDialog() {
  openDialog({
    id: '',
    name: '',
    number: '',
    notes: '',
  }, false);
}

function openEditDialog(id) {
  const m = membersState.members.find((x) => x.id === id);
  if (!m) return;
  openDialog({ ...m }, true);
}

function openDialog(m, isEdit) {
  const html = `
    <div class="modal-backdrop open" id="member-modal" role="dialog" aria-modal="true">
      <div class="modal">
        <h3>${isEdit ? 'メンバーを編集' : '新しいメンバーを登録'}</h3>
        <form id="member-form">
          <div class="field-row">
            <div class="field" style="max-width:90px">
              <label class="field-label">背番号</label>
              <input class="field-input" type="number" name="number" value="${m.number ?? ''}" min="0" />
            </div>
            <div class="field">
              <label class="field-label">名前</label>
              <input class="field-input" type="text" name="name" value="${escapeHtml(m.name)}" required />
            </div>
          </div>
          <div class="field">
            <label class="field-label">メモ</label>
            <textarea class="field-textarea" name="notes">${escapeHtml(m.notes || '')}</textarea>
          </div>
          <p style="font-size:.8rem;color:var(--color-text-muted);margin:0 0 12px">
            ※ ポジションは試合ごとの打順設定で登録します。<br>
            ※ 通算成績は試合の打席記録から自動集計されます。
          </p>
          <div class="modal-actions">
            <button type="button" class="btn" id="member-cancel">キャンセル</button>
            <button type="submit" class="btn btn-primary" id="member-submit">${isEdit ? '更新' : '登録'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const modal = document.getElementById('member-modal');
  const form = document.getElementById('member-form');
  const submitBtn = document.getElementById('member-submit');
  document.getElementById('member-cancel').addEventListener('click', () => modal.remove());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const numberRaw = fd.get('number').toString();
    const newMember = {
      id: m.id || uid('m'),
      name: fd.get('name').toString().trim(),
      number: numberRaw === '' ? null : Number(numberRaw),
      notes: fd.get('notes').toString().trim(),
    };

    submitBtn.disabled = true;
    submitBtn.textContent = '保存中...';
    try {
      const next = { ...membersState };
      if (isEdit) {
        next.members = next.members.map((x) => (x.id === newMember.id ? newMember : x));
      } else {
        next.members = [...next.members, newMember];
      }
      membersSha = await writeJSON(
        CONFIG.DATA_PATHS.members,
        next,
        membersSha,
        isEdit ? `update member ${newMember.name}` : `add member ${newMember.name}`
      );
      membersState = next;
      modal.remove();
      render();
      showToast('保存しました', 'success');
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? '更新' : '登録';
      if (err instanceof ConflictError) {
        showToast(err.message, 'error');
      } else {
        showToast('保存に失敗しました: ' + err.message, 'error');
      }
    }
  });
}

async function deleteMember(id) {
  const m = membersState.members.find((x) => x.id === id);
  if (!m) return;
  if (!confirm(`${m.name} さんを削除しますか？`)) return;
  try {
    const next = { ...membersState, members: membersState.members.filter((x) => x.id !== id) };
    membersSha = await writeJSON(
      CONFIG.DATA_PATHS.members,
      next,
      membersSha,
      `delete member ${m.name}`
    );
    membersState = next;
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
