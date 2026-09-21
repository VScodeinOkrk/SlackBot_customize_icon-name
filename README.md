# Slack 入退室Bot

`/entry-settings` をチャンネル内で実行すると、そのチャンネル専用の入室・退室メッセージを設定できます。実行・保存できるのは `DEVELOPER_USER_IDS` に登録したSlackユーザーIDだけです。

Botの本体プロフィールはSlack全体で共通のため、チャンネルごとに変更するのは入退室通知を投稿する際の表示名とアイコンです。

アイコンには、Slackのサーバーが認証なしで直接取得できる公開HTTPS画像URL（PNG/JPEG/GIF）を指定してください。ローカルファイル、共有ページURL、ログインが必要なURLは画像を読み込めず、プレースホルダー表示になります。`:+1:` のようなSlack絵文字（ワークスペースのカスタム絵文字を含む）も指定できます。

アイコン欄には、Slack絵文字（例: `:wave:`）か、Slackのサーバーから直接取得できる**公開HTTPS画像URL**を入力します。画像の閲覧ページ、ローカルファイルのパス、ログインが必要なURLは使えません。確実に表示したい場合はSlack絵文字を使ってください。

## 起動

起動時にプロジェクト直下の`.env`を読み込みます。環境変数で同名の値が既に渡されている場合も利用できます。`SLACK_APP_TOKEN` がある場合はSocket Modeで起動するため、`SLACK_SIGNING_SECRET` は不要です。

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`（Socket Modeの場合）
- `SLACK_SIGNING_SECRET`（HTTP Modeの場合のみ）
- `DEVELOPER_USER_IDS`（開発者のSlackユーザーID。複数人はカンマ区切り）
- `PORT`（任意。標準は `3000`）

```powershell
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
DEVELOPER_USER_IDS=U01234567,U07654321
```

## Slackアプリの設定

- Slash Command: `/entry-settings`
- Event Subscriptions（Bot Events）: `member_joined_channel`, `member_left_channel`
- OAuth scopes: `chat:write`, `chat:write.customize`, `commands`

イベント受信URLとSlash CommandのRequest URLには、公開した `POST /slack/events` のURLを設定してください。

設定はローカルの `.bot-data/channel-settings.json` に保存され、Git管理対象外です。
