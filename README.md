# 高井戸第二小学校PTA野球部 ホームページ

GitHub Pages 完結（外部サービス不要）の、PTA 野球部向けシンプルサイトです。

## 機能

- **トップ**: チーム紹介・新メンバー募集告知・お問い合わせ（mailto）
- **試合**: 試合結果の登録・一覧
- **メンバー**: メンバー一覧・個人記録
- **出欠**: 練習/試合の出欠登録

## 構成（GitHub だけで完結）

- **ホスティング**: GitHub Pages
- **データ**: 同じリポジトリ内の `data/*.json`
- **書き込み**: ブラウザから GitHub Contents API で commit
- **認証**: 共通パスワードでブラウザ内に暗号化保管した PAT を復号して使用

```
takani-pta-baseball/
├── index.html              トップ（公開）
├── games.html              試合（要パスワード）
├── members.html            メンバー（要パスワード）
├── attendance.html         出欠（要パスワード）
├── css/style.css
├── js/
│   ├── config.js           リポジトリ情報など定数
│   ├── crypto.js           AES-GCM 暗号化/復号
│   ├── auth.js             パスワードゲート
│   ├── api.js              GitHub API ラッパー
│   └── app.js              共通初期化（ナビなど）
├── js/pages/               ページごとのロジック
│   ├── games.js
│   ├── members.js
│   └── attendance.js
├── data/                   データ本体（JSON）
│   ├── members.json
│   ├── games.json
│   ├── events.json
│   └── attendance.json
├── tools/encrypt-pat.html  PAT 暗号化ツール（ローカルで使用）
└── encrypted-pat.json      暗号化済み PAT（セットアップ時に作成）
```

---

## セットアップ手順（管理者向け）

### 1. GitHub リポジトリを作る

1. <https://github.com/new> で新規リポジトリ作成
   - Repository name: `takani-pta-baseball`
   - Public（GitHub Pages 無料利用のため）
2. このフォルダの中身をすべて push

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/takani-pta-baseball.git
git push -u origin main
```

### 2. `js/config.js` の `GITHUB_OWNER` を自分の GitHub ユーザー名に書き換える

```js
GITHUB_OWNER: 'YOUR_GITHUB_USERNAME',  // ここを自分のユーザー名に
```

### 3. GitHub Pages を有効化

1. リポジトリの Settings → Pages
2. Source: `Deploy from a branch`
3. Branch: `main` / `/ (root)` → Save
4. しばらく待つと `https://<YOUR_USERNAME>.github.io/takani-pta-baseball/` でアクセス可能

### 4. Fine-grained Personal Access Token (PAT) を作る

1. <https://github.com/settings/personal-access-tokens/new>
2. Token name: `takani-pta-baseball-write`
3. Expiration: 1 year（毎年更新する）
4. Repository access: `Only select repositories` → `takani-pta-baseball` を選択
5. Permissions（Repository permissions）:
   - **Contents**: `Read and write`
   - その他はデフォルト（No access）のまま
6. `Generate token` → 表示された `github_pat_xxx...` をコピー（一度しか表示されない）

### 5. チーム共通パスワードを決める

- 例: `takani2026baseball`（合言葉感覚で OK）
- メンバーに LINE などで共有
- パスワードを変える時は手順6をやり直すだけ

### 6. PAT を暗号化する

1. このリポジトリをローカルに clone した状態で、`tools/encrypt-pat.html` をブラウザで開く
2. 「PAT」欄に手順4でコピーしたトークンを貼り付け
3. 「パスワード」欄にチーム共通パスワードを入力
4. 「暗号化する」ボタンを押す
5. 表示された JSON をコピー
6. リポジトリ直下に `encrypted-pat.json` というファイル名で保存
7. commit & push

```bash
git add encrypted-pat.json
git commit -m "add encrypted PAT"
git push
```

### 7. 動作確認

1. `https://<YOUR_USERNAME>.github.io/takani-pta-baseball/` を開く
2. 「メンバーログイン」→ 共通パスワードを入力
3. 試合ページで新規登録 → 自動で commit が走り、ページに反映されればOK

---

## 運用上の注意

### セキュリティ

- **このサイトは「友人グループ向け」の割り切り設計**です
- パスワードが漏れると、知っている人なら誰でもデータを書き換え可能
- 漏洩・不審なアクセスがあった場合は **PAT を再発行 → 暗号化 → push** で即座に遮断できます
- 重要な個人情報（電話番号・住所など）は登録しないでください
- データ修正履歴は git log に残るので、誤更新は前のバージョンに戻せます

### PAT の有効期限

- PAT は最長1年で期限切れ
- 期限切れになるとサイトでデータ更新ができなくなります
- カレンダーに「PAT 更新」のリマインダーを入れておきましょう
- 更新時は手順4〜6をやり直し

### パスワード変更

- 手順5でパスワードを変える → 手順6で再暗号化 → push
- 古いパスワードでは復号できなくなります（過去データも当然無事）

### 入部問い合わせの受け取り

- 問い合わせは `kazutake.asahi@gmail.com` 宛のメールで届きます（仮設定）
- 専用 Gmail を作ったら `index.html` の `mailto:` リンクを書き換えてください

### LINE で URL を共有する時のコツ

LINE の内蔵ブラウザは Web Crypto API などの一部機能に制限があり、ログインや書き込みが正しく動かない場合があります。

**LINE グループに URL を貼る時は、末尾に `?openExternalBrowser=1` をつけると、タップで自動的に標準ブラウザ（Safari/Chrome）で開きます:**

```
https://kazutake.github.io/takani-pta-baseball/?openExternalBrowser=1
```

このパラメータをつけていないリンクをタップした場合は、LINE 内ブラウザで開かれて警告バナーが表示されます。バナーの指示に従って「ブラウザで開く」を選んでもらえばOKです。

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

ただしローカルだと GitHub API への書き込みは CORS の関係で動作しない場合があるので、本番動作確認は GitHub Pages 上で行ってください（読み込みは確認できます）。

---

## ライセンス

私的利用前提のため、ライセンス指定なし。チームで自由に改変してください。
