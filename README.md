# Fairy Slack Bot

Socket Modeで動くSlack Botです。入退室通知、スタンプ集計、リマインダー、トークテーマ、ダイス、ルーレットを提供します。

## 起動

Node.js 20.6以上を用意し、Git Bashで実行します。

```bash
cd ~/bot-study
npm install
npm start
```

終了は `Ctrl + C` です。

## トークン設定

プロジェクト直下の `.env` に、Slackで発行したトークンを書きます。

```env
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

- `SLACK_APP_TOKEN`: **Basic Information → App-Level Tokens** で発行。`connections:write` が必要です。
- `SLACK_BOT_TOKEN`: **OAuth & Permissions → OAuth Tokens for Your Workspace** のBot User OAuth Tokenです。

`.env` はGit管理対象外です。Botは起動時にだけ読み込み、値をログ出力しません。

## 開発者の設定

開発者IDは `.env` ではなく、`.bot-data/developers.json` に保存します。

```json
{
  "userIds": [
    "U012ABC34",
    "U056DEF78"
  ]
}
```

`userIds` にSlackメンバーIDを登録した人だけが、`/entry-settings` と `/output-settings` を実行できます。

## Slackアプリ側の設定

### Socket Mode

**Socket Mode** を有効にします。公開URLは不要です。

### Bot Token Scopes

**OAuth & Permissions → Bot Token Scopes** に以下を追加します。

```text
chat:write
chat:write.customize
commands
reactions:read
channels:history
groups:history
```

### Event Subscriptions

**Event Subscriptions → Subscribe to bot events** に以下を追加します。

```text
member_joined_channel
member_left_channel
reaction_added
reaction_removed
```

### Slash Commands

以下を作成します。

| Command | Short Description |
|---|---|
| `/entry-settings` | 入退室通知を設定。例: `/entry-settings` |
| `/output-settings` | Botの表示結果を編集。例: `/output-settings` |
| `/reaction-count` | スタンプを条件指定して集計。例: `/reaction-count` |
| `/bot-remind` | 時間・曜日を選んでリマインダーを作成。例: `/bot-remind` |
| `/bot-topic` | トークテーマを投稿。例: `/bot-topic` |
| `/roll` | 種類と個数を選んでダイスを振る。例: `/roll` |
| `/roulette` | 候補を入力してルーレットを回す。例: `/roulette` |

設定の追加・変更後は、**OAuth & Permissions → Reinstall to Workspace** を実行してください。

Botを使うチャンネルには招待が必要です。

```text
/invite @Fairy
```

## コマンド

### 開発者限定

- `/entry-settings` — チャンネルごとの入室・退室メッセージ、通知時のBot名・アイコンを設定します。`{user}` は対象ユーザーへのメンションに置換されます。
- `/output-settings` — スタンプ集計、リマインダー確認、テーマ、ダイス、ルーレットの結果文テンプレートを編集します。

### 全ユーザー

一般ユーザー向けコマンドは、同じユーザーが30秒以内に連続実行できません。

- `/reaction-count` — 設定画面でスタンプ種類を複数選択できます。未選択なら全種類です。対象ユーザーは初期状態で実行者自身となり、変更できます。集計結果はチャンネル全員に表示されます。
- `/bot-remind` — 時間・曜日・時刻・内容を選んでリマインダーを設定します。毎週の曜日は複数選択でき、時刻は日本時間です。
- `/bot-topic` — ランダムなトークテーマをチャンネルへ投稿します。
- `/roll` — `d4`、`d6`、`d8`、`d10`、`d12`、`d20`、`d100`から種類と個数を選んで振ります。
- `/roulette` — 候補を1行ずつ入力して、進行表示付きのルーレットを回します。

## 保存データ

```text
.bot-data/
├─ channel-settings.json  # チャンネル別の入退室通知設定
├─ bot-state.json         # リマインダー・結果文テンプレートなど
└─ developers.json        # 開発者のSlackメンバーID
```

`.bot-data/` はGit管理対象外です。リマインダーは予定時刻前にBotを再起動しても、再起動時に再登録されます。

## 処理の概要

```text
SlackのSlash Command／イベント
  ↓
Socket ModeでBotが受信
  ↓
権限・連投制限・入力内容を確認
  ↓
設定画面の表示、または処理を実行
  ↓
必要な状態を .bot-data に保存
  ↓
Slackにメッセージを投稿・更新
```
