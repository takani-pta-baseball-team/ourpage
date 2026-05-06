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
          r.runsAllowed = (r.runsAllowed || 0) + (p.rbi || 0);
        }
      }
      // 勝/負は手動入力から拾う（自動推定が難しいため）
      if (ps && ps.pitching) {
        if (ps.pitching.decision === 'win') r.wins++;
        if (ps.pitching.decision === 'loss') r.losses++;
      }
    } else if (ps && ps.pitching) {
      const p = ps.pitching;
      const hasPitching = !!p.decision || PITCHING_KEYS.some((k) => (p[k] || 0) > 0);
      if (hasPitching) r.pitchGames++;
      if (p.decision === 'win') r.wins++;
      if (p.decision === 'loss') r.losses++;
      r.pitchStrikeouts += p.strikeouts || 0;
      r.walks += p.walks || 0;
      r.hitBatters += p.hitBatters || 0;
      r.errors += p.errors || 0;
      r.hitsAllowed += p.hitsAllowed || 0;
    }
  }
  if (r.runsAllowed === undefined) r.runsAllowed = 0;
  r.hits = r.singles + r.doubles + r.triples + r.homeRuns;
  r.plateAppearances = r.hits + r.walksBatter + r.hbpBatter + r.strikeouts + r.flyOuts + r.groundOuts + r.reachedOnError;
  r.atBats = r.plateAppearances - r.walksBatter - r.hbpBatter;
  return r;
}

function formatBattingAvg(hits, pa) {
  if (pa === 0) return '.---';
  const avg = hits / pa;
  return avg.toFixed(3).replace(/^0+/, '');
}

function render() {
  const list = document.getElementById('members-list');
  const members = [...membersState.members].sort((a, b) => {
    const na = a.number ?? 999, nb = b.number ?? 999;
    if (na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '', 'ja');
  });
  if (members.length === 0) {
    list.innerHTML = '<div class="empty">まだメンバーが登録されていません。<br>「＋ 新規登録」から登録してください。</div>';
    return;
  }
  list.innerHTML = members.map((m) => renderMemberCard(m)).join('');
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

function renderMemberCard(m) {
  const mvpCount = gamesState.games.filter((g) => g.mvpId === m.id).length;
  const stats = aggregateStats(m.id);
  const avg = formatBattingAvg(stats.hits, stats.atBats);
  const summary = stats.plateAppearances > 0
    ? `打率${avg} (${stats.hits}/${stats.atBats}) ・ 本塁打${stats.homeRuns} ・ 打点${stats.rbis}`
    : '記録なし';
  return `
    <div class="card" style="cursor:pointer" data-detail="${m.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            ${m.number != null ? `<span style="background:var(--color-primary);color:#fff;padding:2px 8px;border-radius:12px;font-size:.8rem;font-weight:600">#${m.number}</span>` : ''}
            <span class="card-title" style="margin:0">${escapeHtml(m.name)}</span>
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
