# MCP Tools Monorepo

このリポジトリは、Model Context Protocol (MCP) のツールとサーバーを管理するmonorepoです。

## フォルダ構造

```
mcp-tools/
├── servers/     # MCPサーバーの実装
│   ├── memory-store/  # メモリストレージサーバー
│   ├── npm-info/      # NPMパッケージ情報サーバー
│   └── slack/         # Slack統合サーバー
├── libs/        # 共有ライブラリとユーティリティ
│   └── typescript-config/  # 共有TypeScript設定
├── examples/    # サンプル実装とデモ
└── docs/        # ドキュメント
```

## 利用可能なMCPサーバー

### memory-store
インメモリストレージを提供するMCPサーバー。キーバリューストアとして機能し、一時的なデータの保存と取得が可能です。

### npm-info
NPMパッケージの情報を取得するMCPサーバー。パッケージの最新情報、リリース履歴、依存関係の分析などが可能です。

### slack
Slack統合用のMCPサーバー。メッセージの送信、チャンネル一覧の取得、ユーザー情報の取得などが可能です。

## 開発方法

### 依存関係のインストール

```sh
bun install
```

### ビルド

全てのパッケージをビルドします：

```sh
bun run build
```

### 開発モード

開発モードで全てのパッケージを起動します：

```sh
bun run dev
```

### リント/フォーマット

```sh
# リント
bun run lint

# フォーマット
bun run format
```

## 新しいMCPサーバーの追加

1. `servers/`ディレクトリに新しいパッケージを作成
2. `@modelcontextprotocol/sdk`を依存関係に追加
3. MCPサーバーの実装を作成
4. `package.json`の`workspaces`に新しいパッケージを追加（必要な場合）

## 技術スタック

- [TypeScript](https://www.typescriptlang.org/)
- [Turborepo](https://turbo.build/repo)
- [Biome](https://biomejs.dev/)
- [Model Context Protocol SDK](https://github.com/ModelContext/protocol)
