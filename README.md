# 高井戸第二小学校PTA野球部 ホームページ

GitHub Pages 完結（外部DB不要）の、PTA 野球部向けサイト。チームの活動告知から、試合スコア・打席記録・出欠・選手成績まで一気通貫で管理できる。

- **公開URL**: <https://takani-pta-baseball-team.github.io/ourpage/>
- **集計ルール**: <https://takani-pta-baseball-team.github.io/ourpage/rules.html>
- **入部問い合わせフォーム**: <https://forms.gle/jtj6yVM7sZMpCvef8>

---

## 機能一覧

### 🏠 トップページ（公開・ログイン不要）

- チーム紹介・新メンバー募集メッセージ（金枠で強調）
- **これからの予定** を自動表示（events.json から最新6件）
- **試合写真の自動スライドショー**（games.json の写真から最新8枚を4.5秒間隔でフェード切替）
- 入部問い合わせボタン → **Google Form** に遷移
- メンバー専用領域へのログインボタン
- 集計ルールページへのリンク

### ⚾ 試合（要パスワード）

- 試合一覧・新規登録・編集・削除
- **予定（試合区分）から選んで作成**：日付・場所が自動入力される
- **イニング別スコアボード**（先攻/後攻トグル付）
- **MVP** 設定（手動）
- **試合写真**: 複数枚アップロード、サムネイルタップでフルスクリーンLightbox
  - 自動で1280pxにリサイズ + EXIF（GPS）削除
- **🏁 試合終了 / スコア確定**：確定するとカードに🏁バッジ、打席記録は読み取り専用に

#### 📝 打席記録モーダル（試合カードから開く）

- **打順タブ**: 先攻/後攻設定、メンバー追加/並び替え/削除、各選手の守備位置（試合ごと）
  - リンク予定がある場合：**「○ 出席メンバーを打順に一括追加」** ボタン
  - 「追加できるメンバー」候補は **○出席のみ** で絞り込み
  - 各行に **🔄 交代ボタン**（任意位置の選手を入れ替え）
- **攻撃タブ**: 1打席ずつ結果を記録
  - 結果12種類（ヒット/二塁打/三塁打/本塁打/四球/死球/エラー/他セーフ/三振/フライ/ゴロ/他アウト）
  - 打点を ± で調整
  - **3アウトで自動的に守備タブへ切替**
  - 過去の打席は **編集・削除** 可能
  - **🔄 交代ボタン**で任意の打順に対して選手交代（過去PAは元のまま）
- **守備タブ**: 相手打席を記録 + 投手指定
  - 「投手」ポジションの選手が自動的に守備投手として表示
  - 「変更」ボタンで投手交代（打順タブのポジションと連動）
  - **3アウトで自動的に攻撃タブへ切替**
- **すべての操作で自動保存**（明示的な保存ボタンは不要、「閉じる」だけ）

#### 自動集計

- 各回の得点 = 打点合計（攻撃）/ 失点合計（守備）から自動算出
- 試合のスコアボードは打席記録から自動生成
- 勝/負投手の自動判定（最多打席投手 + 試合結果）
- 相手の打席結果から投手の **奪三振 / 与四球 / 与死球 / 被安打 / 失策出塁 / 失点** を自動集計

### 👥 メンバー（要パスワード）

- メンバー一覧・新規登録・編集・削除
- 登録項目: 背番号、名前、メモ
- **打撃通算成績の自動集計**（試合の打席記録から）：打率・打席・打数・安打・本塁打・打点・三振・フライ・ゴロ・四球・死球・他セーフ・他アウト・失策出塁
- **投手通算成績の自動集計**: 登板数・勝-敗・奪三振・与四球・与死球・被安打・失点・失策出塁
- **MVP獲得試合数** の自動カウント
- **並び替え**: 背番号 / 名前 / 打率 / 打席 / 打数 / 安打 / 本塁打 / 打点 / MVP / 勝 / 奪三振（成績順では順位バッジ表示）

### 📅 出欠（要パスワード）

- 予定一覧・新規追加・編集・削除
- 種別: 練習 / 試合 / 懇親会 / その他
- **新規予定のデフォルト**: 次の日曜・07:00〜09:00・練習・高井戸第二小学校 校庭
- 予定カードでメンバーごとに **○ / △ / ×** を登録
- カードは折りたたまれて表示される（タップで展開）
- **試合区分の予定 → 試合との連携**: 試合ページから「+ 新規登録」した時にこの予定をリストから選択可能（双方向リンク）

### 📖 集計ルールページ（公開）

- 7セクションでサイト内のすべての自動判定ルールを解説
  - 打席結果の種類 / 打撃成績 / 投手成績 / 勝敗判定 / イニングスコア / 自動進行 / MVP

### 📨 入部問い合わせ自動化（Google Form + Apps Script）

- ホームの問い合わせボタン → Google Form
- フォーム送信時に Apps Script が自動実行:
  1. **チームの LINE グループに通知** を Push
  2. **入部希望者に確認メール** を自動送信
- 詳細は [`apps-script/README.md`](apps-script/README.md) 参照

---

## アーキテクチャ

- **ホスティング**: GitHub Pages（組織所有: `takani-pta-baseball-team/ourpage`）
- **データストア**: 同リポジトリ内の `data/*.json` を GitHub Contents API 経由で直接読み書き
- **認証**: チーム共通パスワードで AES-GCM 暗号化された PAT を復号 → API 認証に使用
- **静的サイト**: ビルドステップなし、ES Modules で動作
- **画像配信**: GitHub Pages 経由
- **問い合わせ自動化**: Google Forms + Google Apps Script + LINE Messaging API

```
ourpage/
├── index.html                 トップ（公開）
├── games.html                 試合（要ログイン）
├── members.html               メンバー（要ログイン）
├── attendance.html            出欠（要ログイン）
├── rules.html                 集計ルール（公開）
├── encrypted-pat.json         暗号化済み PAT
├── css/style.css
├── js/
│   ├── config.js              リポジトリ・チーム設定
│   ├── crypto.js              AES-GCM/PBKDF2 暗号化・復号
│   ├── auth.js                ログインモーダル
│   ├── api.js                 GitHub Contents API ラッパー
│   ├── app.js                 共通UI（ヘッダ・ナビ・トースト・LINE banner）
│   ├── plays.js               打席結果定義・集計ヘルパー
│   ├── imageutil.js           画像リサイズ・base64変換
│   └── pages/
│       ├── games.js           試合ページ + 打席記録モーダル
│       ├── members.js         メンバーページ + 並び替え
│       └── attendance.js      出欠ページ
├── data/                      JSON データ
│   ├── members.json
│   ├── games.json
│   ├── events.json
│   └── attendance.json
├── images/games/<gameId>/     試合写真（リサイズ済 JPEG）
├── tools/
│   └── encrypt-pat.html       PAT 暗号化ツール
└── apps-script/
    ├── form-submit.gs         Google Form 連携スクリプト
    └── README.md              Apps Script セットアップ手順
```

---

## セットアップ手順（管理者向け）

すでに本サイトの運用者は以下を実施済み。新規にコピーして別チームで使う場合の参考。

### 1. GitHub リポジトリを作る

1. <https://github.com/new> で新規リポジトリ作成
   - Repository name: `ourpage`
   - **Public**（GitHub Pages 無料利用のため）
2. このフォルダの中身をすべて push

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/<organization>/ourpage.git
git push -u origin main
```

### 2. `js/config.js` のチーム情報を書き換える

```js
TEAM_NAME: '高井戸第二小学校PTA野球部',     // 表示名
GITHUB_OWNER: 'takani-pta-baseball-team', // GitHub組織名
GITHUB_REPO: 'ourpage',                    // リポジトリ名
```

### 3. GitHub Pages を有効化

1. リポジトリの Settings → Pages
2. Source: `Deploy from a branch`
3. Branch: `main` / `/ (root)` → Save
4. 数分待つと `https://<organization>.github.io/ourpage/` でアクセス可能

### 4. Fine-grained Personal Access Token (PAT) を作る

1. <https://github.com/settings/personal-access-tokens/new>
2. Token name: `ourpage-write`
3. Expiration: 1 year（毎年更新）
4. **Resource owner**: 必ずリポジトリの所有者（組織）を選択
5. Repository access: `Only select repositories` → `ourpage` を選択
6. Permissions（Repository permissions）:
   - **Contents**: `Read and write`
7. `Generate token` → 表示された `github_pat_xxx...` をコピー（一度しか表示されない）

### 5. チーム共通パスワードを決める

例: `takani2026baseball`。LINE などでメンバーに共有。

### 6. PAT を暗号化する

1. ローカルに clone 済みの状態で `tools/encrypt-pat.html` をブラウザでダブルクリック
2. PAT を貼り付け、共通パスワードを入力
3. 「暗号化する」 → 出力 JSON を `encrypted-pat.json` として保存
4. リポジトリ直下に配置して push

```bash
git add encrypted-pat.json
git commit -m "add encrypted PAT"
git push
```

### 7. 動作確認

1. <https://takani-pta-baseball-team.github.io/ourpage/> を開く
2. 「メンバーログイン」 → 共通パスワード入力
3. メンバー登録 / 試合登録 / 出欠登録などが commit されてサイトに反映されればOK

### 8. （オプション）入部問い合わせの自動化

[`apps-script/README.md`](apps-script/README.md) を参照して Google Form + Apps Script を設定。

---

## 運用上の注意

### セキュリティ

- 友人グループ向けの割り切り設計。共通パスワードが漏れると、知っている人なら誰でもデータを書き換え可能。
- 漏洩・不審なアクセスがあった場合は **PAT 再発行 → 再暗号化 → push** で即座に遮断できる
- 個人情報（電話番号・住所など）はサイトに登録しないこと
- データ修正履歴は git log に残るので、誤更新は前のバージョンに戻せる
- 写真は誰でもURLで見られる状態なので、顔出しNGの場合は載せない

### PAT の有効期限

- PAT は最長1年。期限切れ後は書き込みができなくなる
- カレンダーに「PAT 更新」のリマインダーを入れる
- 更新時は手順 4〜6 をやり直し

### パスワード変更

- 手順 5 でパスワードを変える → 手順 6 で再暗号化 → push
- 古いパスワードでは復号できなくなる（過去データは無事）

### LINE で URL を共有する時のコツ

LINE の内蔵ブラウザは Web Crypto API などの一部機能に制限があり、ログインや書き込みが失敗する場合がある。

LINE グループに URL を貼る時は、末尾に `?openExternalBrowser=1` をつけると、タップで自動的に標準ブラウザ（Safari/Chrome）で開く:

```
https://takani-pta-baseball-team.github.io/ourpage/?openExternalBrowser=1
```

このパラメータが無いリンクをタップすると、LINE 内ブラウザで開かれて警告バナーが表示される。

### 部長の交代について

リポジトリは GitHub Organization (`takani-pta-baseball-team`) 所有なので、部長交代時はリポジトリ譲渡は不要。
組織のメンバーに次期担当を追加するだけで権限を渡せる。

新しい担当者が PAT を発行する場合は、Resource owner で組織を選択すれば組織配下のリポジトリに対するスコープが付けられる。

---

## ローカルでの確認

GitHub Pages にデプロイする前に手元で確認したい場合:

```bash
# Python があれば
python -m http.server 8000

# Node.js があれば
npx serve .
```

ブラウザで `http://localhost:8000/` を開く。

ローカルだと GitHub API への書き込みは CORS の関係で動作しないことがあるので、本番動作確認は GitHub Pages 上で行うこと。

---

## ライセンス

私的利用前提のため、ライセンス指定なし。チームで自由に改変してください。
