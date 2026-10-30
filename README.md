<p align="center"><img src="apps/mobile/assets/brand/meetile-logo.svg" alt="Meetile" width="480"></p>

# Meetile

**会った人のピースだけが、偶然と不自由さを伴って一枚のアートにつながる、対面起点の日替わりSNS。**

毎朝、一人ひとりに形の違うパズルのピースが1枚配られます。その日の写真を撮ってピースにし、実際に会った人とスマホを近づけて「FIT」すると、二人の盤面がつながります。友達の友達のピースも盤面に入ってくるので、自分の交友関係の外側にいる人の存在が見えます。プロフィール・フォロー・DM・おすすめはありません。翌朝4時に盤面は確定し、Galleryに残ります。

## 主な機能

- **Today**：その日のピースと写真。撮影から投稿前の審査、盤面の表示までを1画面で行う
- **FIT（対面接続）**：BLEで近くの相手を見つけ、相手のピースを確かめて双方が承認すると、サーバーが二つの盤面を統合する。対応端末ではUWB（iPhoneのNearby Interaction／AndroidのRanging API）も使う
- **Gallery**：日付ごとの最終盤面を端末に保存し、オフラインでも見られる
- **書き出し・共有**：盤面を画像にしてSNSへ共有する
- **安全機能**：通報・ブロック・本人の写真削除・利用終了と、運営用の管理画面（審査・非表示・利用停止・監査記録）

## 技術的なポイント

- **パズルエンジン**（`packages/puzzle-engine`）：ピース生成と盤面統合をReact Native・Firebaseから独立した純粋なTypeScriptで実装。統合は回転なしの平行移動で接触辺が最大になる配置を選び、同じ入力なら同じ結果になる。fast-checkによるプロパティテストで検証
- **サーバーが正本**：日付、ピース生成、FITの可否、盤面の統合、削除は Cloud Functions 側で判定し、クライアントは正本を直接書き換えない
- **iPhone–Android間の近接通信**：Swift（Core Bluetooth・Nearby Interaction）とKotlin（BLE・GATT・Ranging API）のネイティブモジュールを自作（`apps/mobile/modules/proximity`）。異なるOS間でGATTリンクを共有する工夫と、実機で測ったRSSIによる距離しきい値・OS間の補正を入れている
- **安全とプライバシー**：表示用データと安全管理用の識別子を分け、安全IDや通報内容をクライアントへ出さない

| 領域         | 使用技術                                                                     |
| ------------ | ---------------------------------------------------------------------------- |
| モバイル     | Expo（Development Build）、React Native、Skia、expo-camera、expo-sqlite      |
| ネイティブ   | Swift（Core Bluetooth、Nearby Interaction）、Kotlin（BLE、Ranging API）      |
| バックエンド | Firebase（Auth、Firestore、Storage、Cloud Functions、App Check）             |
| 管理画面     | Next.js、Firebase Admin SDK                                                  |
| 開発・テスト | pnpm workspace、TypeScript strict、Jest、fast-check、Firebase Emulator Suite |

## 現在の状況

ハッカソン向けのプロトタイプです。実クラウドには配備しておらず、Mac上のFirebase Emulatorをサーバーにして、iPhone 16とAndroid 13の実機で動かしています。

- 実機で確認済み：撮影→Today、iPhone–Android間のFIT（相互検知→ピース確認→双方承認→盤面統合）、Gallery、書き出し・共有、通知の許可
- 未完了：距離判定の合格試行（各条件20回）、遠隔通知（FCM／APNs）、実クラウドへの配備、利用規約などの確定（[初稿](docs/legal/README.md)は未発効）
- BLEの距離判定はRSSIの推定であり、正確な10 cmを保証するものではない

## ドキュメント

- [プロダクト仕様書](docs/PRODUCT_SPEC.md)・[実装計画](docs/IMPLEMENTATION_PLAN.md)
- 各Phaseの実装と検証の記録：`docs/PHASE*.md`（例：[混在FIT](docs/PHASE5_MIXED_FIT.md)、[距離しきい値の補正](docs/PHASE5_GPROX_CALIBRATION.md)、[Gallery・書き出し](docs/PHASE6_DEMO.md)、[UIリデザイン](docs/UI_REDESIGN.md)）
- [ローカル起動手順](docs/PHASE3_LOCAL_SETUP.md)

開発にはAIコーディングエージェント（Claude Code・Codex）を使っています。作業ルールは[AGENTS.md](AGENTS.md)・[CLAUDE.md](CLAUDE.md)、作業ごとのモデル選択は[AIモデルの案内](docs/AI_IMPLEMENTATION_GUIDE.md)に記録しています。

## 開発環境

Node.js **22.23.3**、pnpm **10.34.6**を使用する。Nodeは`.node-version`と`.nvmrc`、pnpmは`package.json`の`packageManager`、依存は`pnpm-lock.yaml`で固定している。対応するNodeを選択し、指定版pnpmを用意した環境で実行する。

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

今回のMacには、システムのNodeを変更せず、公式配布物のSHA-256を確認したNodeとpnpmを`.tools/`へ配置した。このローカル環境を使う場合は、リポジトリのルートで次を先に実行する。

```sh
export PATH="$PWD/.tools/node-v22.23.3-darwin-arm64/bin:$PWD/.tools/pnpm/node_modules/.bin:$PATH"
```

`.tools/`はGitに含めない。別のMacやCIでは、それぞれ指定版のNodeとpnpmを用意する。今回、シェル起動設定やグローバルなCLIを変更していない。

## 構成

| ディレクトリ                   | 内容                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `packages/contracts`           | 幾何型、辺、座標、seed、統合結果のZodスキーマ             |
| `apps/mobile`                  | 撮影・投稿前審査・Today・設定のDevelopment Buildアプリ    |
| `packages/design`              | 配色・固定向きのピース輪郭                                |
| `apps/functions`               | サーバー日付、認可、FIT、安全処理の内部基盤               |
| `firebase`                     | Firestore／Storage Rules、indexes、独立配備用SDK lockfile |
| `tests/emulators`              | Auth・Firestore・Storage・Functionsの統合試験             |
| `packages/puzzle-engine`       | 生成、盤面検証、候補列挙、配置評価、最大接触統合          |
| `tools/puzzle-simulator`       | 人工ピースを使う開発用CLI、JSONとSVG出力                  |
| `scripts/check-boundaries.mjs` | 純粋パッケージの依存・暗黙の時刻／乱数参照の検査          |
| `.github/workflows/ci.yml`     | lockfile、整形、Lint、型、テスト、CLIの検査               |

TypeScriptはstrict。パッケージはCommonJSでビルドし、workspace内の参照を使う。`pnpm build`で`dist/`と宣言ファイルを生成する。エンジンはReact Native、Firebase、時計、ネットワーク、保存先を持たない。

## エンジンの使い方

```ts
import {
  createSeededRandom,
  generatePiece,
  mergeBoards,
} from '@puzzle-sns/puzzle-engine';

const random = createSeededRandom(42); // 開発実験用
const a = {
  pieces: [generatePiece('synthetic-a', random)],
  participantKeys: ['synthetic-member-a'],
};
const b = {
  pieces: [generatePiece('synthetic-b', random)],
  participantKeys: ['synthetic-member-b'],
};
const result = mergeBoards(a, b, 73);
```

四辺を独立に4種類から生成する。生成用の乱数は引数として受け取り、`[0, 1)`の値を要求する。本番生成にはサーバー側で安全な乱数源を与える。`createSeededRandom`は再現用の非暗号学的PRNGであり、秘密鍵や認証・近接トークンの生成に使用しない。

`mergeBoards`はAの座標を保ち、B全体を整数平行移動する。回転・個別再配置は行わない。全接触辺の互換性、セル重複、参加重複、20ピース上限を確認し、最大接触の配置を選ぶ。同率候補は座標順を固定してseedで選択する。同じ入力とseedなら同じ結果になり、入力配列の列挙順にも依存しない。

`participantKeys`は内部計算用の不透明な重複判定キーであり、クライアントへ返すDTOではない。安全ID、写真、認証、通報、削除キーを格納しない。実際の所有者対応、FIT資格、日付、盤面版本、seed生成と確定トランザクションはFunctions側で検証する。近接検証との接続はPhase 5に残る。

正常な盤面同士の不成立は`{ status: 'not-merged', reason }`を返す。不正・非連結・内部辺不整合の盤面は`InvalidBoardError`、不正seed等はスキーマエラーとなる。座標と演算結果はJavaScriptの安全な整数範囲を要求し、精度を失う演算は拒否する。

## シミュレーター

```sh
pnpm simulate --seed 42 --trials 100 --participants 20 --output artifacts/phase1
```

`seed`はuint32、`trials`は1〜10,000、`participants`は1〜20。各試行で人工ピースを生成し、まだ試していない盤面ペアを選んで統合する。盤面が変われば新しい組み合わせとして試す。全ペアが不成立、または一つの盤面になった時点で終了する。

- `report.json`：試行条件、試行したペア数、成功／不成立数、接触数・最終盤面サイズの分布、最初の試行の最終盤面。
- `boards.svg`：最初の試行の最終盤面を横に並べた表示。写真は使用しない。

同じ条件なら出力は再現できる。成功率はこのペア選択方式での幾何実験であり、実際の利用者体験や近接精度の測定ではない。SVGのタブ寸法は開発可視化用。モバイルのSkia輪郭はpackages/designに置く。

## 検証

`pnpm test`は先にworkspaceをビルドし、Jestとfast-check、モバイルのJest／React Native Testing Libraryを実行する。独立した総当たり、穴・細長い盤面、全256形状、全16接触組み合わせ、20／21ピース境界、入力不変性、連続統合、CLIを検証する。`pnpm test:coverage`でカバレッジを出力する。CLIは別プロセスの出力を試験し、Jest内のカバレッジ集計から除外している。

fast-checkは各propertyを300回検証する。失敗時に表示されるseedとpathで反例を再現できる。

```sh
pnpm build
FC_SEED=123 FC_PATH='0:1' pnpm exec jest --runTestsByPath packages/puzzle-engine/tests/properties.test.ts -t '対象のテスト名'
```

Phase 2ではJDK 21をPATHに用意し、次を実行する。ローカルEmulator専用のdemoプロジェクトを使い、Firebaseへのログインは不要。初回は依存とEmulator配布物のダウンロードが必要。

```sh
pnpm test:emulators
pnpm check:functions-artifact
```

実サービス設定、認可の詳細、試験範囲と残作業は[Phase 2記録](docs/PHASE2.md)・[Phase 3記録](docs/PHASE3.md)を参照する。GitHub Actions上のCI実行は未確認。iPhone／Android、BLE／UWB、実審査、端末キャッシュ、運営機能の検証は、それぞれ担当Phaseで行う。

## モバイルの確認

Phase 3の画面・審査・安全境界・実機準備は[PHASE3.md](docs/PHASE3.md)を参照。Expo Goには対応しない。実Firebase、App Check、HTTPSの利用文書、更新したXcode／Android環境とDevelopment Buildが必要。

```sh
pnpm check:mobile
pnpm --filter @puzzle-sns/mobile exec expo install --check
pnpm --filter @puzzle-sns/mobile export
```

`check:mobile`は読み取りだけの準備検査。現在の未設定状態では終了コード2で不足を報告する。`export`の成功はJavaScript／Hermesのビルド確認であり、スマホで動作確認したことを意味しない。外部ベータは安全機能・運営・Phase 7のゲート通過まで開始しない。
