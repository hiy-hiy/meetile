# Phase 2：バックエンド基盤の実施記録

実施日：2026年10月10日。対象は[仕様書](PRODUCT_SPEC.md)§27のPhase 2と[実装計画](IMPLEMENTATION_PLAN.md)。ユーザーの「未作成・まずローカルで進める」に従い、Firebaseプロジェクトの作成・課金・配備を行わず、ローカルEmulatorで実装・検証した。

**ローカルのバックエンド基盤は実装・検証済み。実サービス側のPhase 2設定は未完了。** モバイル、撮影・審査パイプライン、運営画面、ネイティブ近接、Gallery、通知は、それぞれ後続Phaseの作業として残る。Phase 3には進んでいない。

## 成果物と境界

| 成果物                              | 内容                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/functions`                    | Node 22・Functions v2。日付、認可、審査済みピース生成、FITトランザクション、表示データ、安全処理の内部基盤 |
| `packages/contracts/src/backend.ts` | クライアント向けの厳密なZodスキーマ。非公開型はFunctions内に置く                                           |
| `firebase/`・`firebase.json`        | Firestore／Storage Rules、FITセッションTTL設定、ローカルEmulator構成、独立配備用SDK lockfile               |
| `tests/emulators`                   | Auth・Firestore・Storage・Functionsの実Emulatorを使う統合試験                                              |
| `scripts/`                          | Functionsの共有パッケージ同梱、配備物の独立検査、Emulator実行、実環境の対応表検査                          |
| `.github/workflows/ci.yml`          | Java 21、Emulator試験、配備物検査を追加。GitHub上の実行は未実施                                            |

パズルエンジンはReact Native・Firebase・外部時刻に依存しない。Functionsはエンジンに暗号学的乱数を与えて四辺を生成し、FITの同率選択にはセッションIDと正規順序の最新盤面ID・版本からseedを作る。クライアントから位置・辺・seed・所有者IDを受け取らない。

ルートのFirebase Web SDKはRules・匿名Authを試験するための開発依存である。製品モバイルのSDKは仕様のReact Native Firebaseを維持する。FunctionsではFirebase Admin SDKを使う。Node 22を固定したまま実行できるRules試験パッケージを採用した。

SDKのCommonJS／ESM相互運用の型検査には、Functions・検査用tsconfigの`module: Node20`を使う。実行環境はNode 22、strictと依存ライブラリの型検査を維持する。共有パッケージの設定は維持した。

## 公開API

すべて匿名Auth、検証済みApp Check、実行先と`PUZZLE_PROJECT_ID`の一致を要求する。余分な入力フィールドを拒否し、非公開ID・文書パス・原本のエラーや要求本文を利用者へ返したりログへ出したりしない。

| Callable        | 入力            | 処理・返却                                                                                                                     |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `getDayState`   | `{}`            | サーバー日付、本人の現在のピースID・盤面ID・写真状態。初回の非公開主体を生成し、本人用購読ポインターを更新                     |
| `syncBoardView` | `{ boardId }`   | 参加者本人が閲覧できる現在／過去の盤面を、最新の安全状態で再生成。写真・署名・キャプションを閲覧者別に無地化                   |
| `confirmFit`    | `{ sessionId }` | 非公開の相互検知済み二者セッションを検証し、二人の確認・現在の資格・最新盤面を使って確定。相手の盤面全体や非公開情報は返さない |

公開されているFunctionsはこの3つだけ。`publishApprovedPiece`はPhase 3の信頼された審査パイプライン用の内部処理、`createVerifiedSession`はPhase 5の相互検知検証用の内部処理であり、利用者から呼べる発行APIは存在しない。試験の承認済み写真・相互検知は人工fixtureであり、自動審査や実距離検知の成功を示さない。試験の30秒期限を製品のセッション期限として採用していない。

## データと認可

| 文書・オブジェクト                                   | 読み取り・用途                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `subjects/{uid}`                                     | 非公開。匿名Auth主体に対応する安全状態と認可版本。分析・推薦・日をまたぐ人物表示には使わない                   |
| `days/{day}/members/{uid}`                           | 非公開。その日に限った本人のピース・最新盤面・内部重複判定キー                                                 |
| `boards/{boardId}`・`pieces/{pieceId}`               | 非公開正本。形状・配置・版本・所有者対応・写真公開状態                                                         |
| `approvals/{id}`                                     | 非公開。Phase 3でのみ書き込む審査結果。保留・拒否・別日の承認からは生成しない                                  |
| `fitSessions/{id}`                                   | 非公開・短期。二者、期限、相互検知、確認、再試行結果。期限をAPIで検証し、`expireAt`のTTLを配備時に有効化       |
| `views/{uid}/boards/{boardId}`                       | 本人の許可された文書だけ取得・購読可。一覧・書き込みは不可。安全ID・参加者対応表・内部キー・通報理由を含めない |
| `viewGrants/{uid}/boards/{boardId}`                  | 非公開。盤面参加と認可版本の一致をRulesで判定                                                                  |
| `clientState/{uid}`                                  | 本人だけ取得・購読可。現在の日付・最新盤面ID・再同期用の認可版本。人間関係や人数の指標を含めない               |
| `mediaAccess/{pieceId}`                              | 非公開。画像の公開状態と、最大20人の許可主体・認可版本                                                         |
| `blocks/{pairHash}`・`hidden/{uid}/pieces/{pieceId}` | 非公開。相互安全ブロック・通報者だけの無地化                                                                   |
| `deletionJobs/{pieceId}`                             | 非公開。画像の物理削除をPhase 4で再試行するための待ち行列                                                      |
| Storage `normalized/{pieceId}/image`                 | 許可された本人だけ認証付き取得。列挙・利用者の書き込み・未審査領域の取得は拒否                                 |

Rulesは既定で拒否する。Firestore表示文書の取得は安全主体・盤面権限の2文書、Storageは安全主体・画像権限の**2種類の文書**だけを参照する。同じ文書への反復参照はキャッシュされ、Storage Rulesの参照上限内で許可／拒否を実Emulatorで試験した。[Storage Rulesの条件](https://firebase.google.com/docs/storage/security/rules-conditions)

画像は公開URL・恒久ダウンロードトークンを発行せず、認証付きSDKから取得する。Phase 3では、審査・再エンコード・EXIF除去・トークン不付与の確認を完了してから内部承認を作る必要がある。現在、利用者からの撮影アップロードはすべて拒否する。

ブロック・通報後の無地化・削除・利用停止の内部処理は認可版本を原子的に更新する。これにより、古い表示文書と画像権限を即座に拒否する。利用者側は`clientState`の変更を購読して、表示の破棄・再取得・購読更新を行う。端末実装はPhase 3・4・6に残る。Rulesによる取得拒否だけで端末上の既存画像が消えたとは扱わない。

安全処理の内部メソッドは公開APIにしていない。Phase 4で呼出者・対象の認可、通報原本、審査キュー、監査、本人一括削除、問い合わせ、物理削除workerを接続して完成させる。Phase 6でオフライン保存・Gallery・書き出しへの削除同期を完成させる。画像の物理削除待ちでも新規取得は閉じる。

## 日付・FIT・同期

日本時間4時を日付境界にし、端末時計を受け付けない。各要求とトランザクションの再試行がサーバー日付を判定する。Schedulerを前提とせず、前日への新規生成・FITを拒否する。過去盤面への安全上の無地化はD-01に従って許可する。

**D-09（今回のユーザー承認）：FITの確定時点は、トランザクション内で書き込みを予約する直前の最後のサーバー時刻判定とする。** その判定が4時を越えた場合は不成立。Firestoreの保存完了が4時を越えた場合でも、最後の判定が4時前なら前日分として確定する。再試行時は時刻を再確認する。撮影・Galleryの画面や確定処理は後続Phaseで、この承認と仕様の撮影日付規則を併読する。

Phase 6の最終保存では、この論理的な確定時点と整合するよう、4時前に最後の判定を通ったFITの保存完了との競合・遅延を試験する。Schedulerが単に4時に読み取った値を固定し、未完了の承認済みFITを落とす実装にしない。最終保存の調停は今回未実装である。

FITは、両者の有効な当日写真、主体の利用状態、期限、当日所属を検証する。先に成立した統合が盤面を変えるとFirestoreが再試行し、最新版で重複参加・20人上限・全接触・干渉を再判定する。成立時は正本、全参加者の所属、旧閲覧権限の失効、新表示文書、画像ACL、購読ポインター、セッション結果を一つのトランザクションで更新する。不成立では盤面を変えない。

削除された本人は当日FITできず、再投稿でも同日のピースを置換できない。他の参加者は形状・配置を残して成長を継続できる。ブロックした二人が間接的に同じ盤面に入った場合は両方向の内容を無地化する。

セッションの結果は期限内の再試行だけに用い、FIT履歴API・分析・通知には使わない。TTL削除の即時性には依存しない。統合前の正本は`retired`で取得を拒否する。Phase 6の最終盤面保存では不要な中間盤面・無効な表示文書・日次対応を整理し、最終作品と削除に必要な非公開対応だけを保持する。これを人物関係の履歴・分析へ転用しない。

## 再現手順と検証結果

Node 22.23.3、pnpm 10.34.6に加え、**PATH上にJDK 21**が必要。Android用JDK 17とは分ける。ランナーはJavaの実際の`java.home`を検出してEmulator子プロセスの`JAVA_HOME`を設定する。グローバルなFirebase CLIを使わず、workspaceの固定版を使う。

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:emulators
pnpm check:functions-artifact
```

Emulatorは`127.0.0.1`のAuth 9099、Firestore 8080、Storage 9199、Functions 5001で起動する。既存のEmulatorを停止してから実行する。初回はSDK依存とEmulator配布物をダウンロードするためネットワークが必要。試験は固定の`demo-puzzle-sns-development`を使い、3サービスのローカルhost指定がなければ開始を拒否する。staging／productionの分離試験も`demo-`名前空間だけを使う。

CLI設定はGit対象外の`.tools/firebase-cli-config`へ分離し、継承した`FIREBASE_TOKEN`・`GOOGLE_APPLICATION_CREDENTIALS`をテスト子プロセスから外す。Emulator用の非秘密パラメーターだけをGit対象外の`apps/functions/deploy/.env.local`に生成する。

初回のCLI起動では、既存ログインのローカルADC補助ファイルがCLIによって自動生成・更新された。以後は設定を上記の専用ディレクトリに分離した。既存の認証ファイルは内容を読み出さず、削除せず、Gitへ追加していない。外部プロジェクトの作成・設定変更・配備は行っていない。

Auth／Storage SDKの一部はJest VMの動的ESM importに対応しないため、匿名トークンのAdmin検証と人工画像のAdmin保存をネイティブNode 22子プロセスで行う。Firebase SDK、Emulator、Rules、トランザクションをモックに置き換えていない。Jest内のFirestore SDKが認証メタデータを探す警告を出す場合があるが、接続先は明示したローカルEmulatorであり、試験は成功している。

`pnpm test:coverage`も成功した。この集計は単体試験だけを対象とし、別実行のEmulator統合試験は含まない。バックエンドの統合処理をこの数値だけで未試験／合格と判断せず、下表の統合試験結果と併読する。

| 検査                                   | 結果・証拠                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 整形・Lint・型・純粋エンジンの依存境界 | 成功                                                                                                                  |
| `pnpm test`                            | 6スイート79件。Phase 1回帰、日付、seed、APIの非公開フィールド拒否、匿名Auth／App Checkガード、環境対応表の検査        |
| `pnpm test:emulators`                  | 3スイート22件。下表の実SDK・実Rules・実トランザクション試験                                                           |
| `pnpm check:functions-artifact`        | workspace外の一時ディレクトリで`npm ci`し、公開3関数のロード・App Checkなしの拒否・環境パラメーター不一致の拒否を確認 |
| 原本・スコープ                         | AGENTS.md・PRODUCT_SPEC.mdを変更せず、モバイル・管理画面・将来復元・永久除外機能を追加していない                      |

| 要件・判断                                     | Emulator等で確認したこと                                                                                                                               | 後続・手動で残ること                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| PS-03-001〜004、PS-10-001〜005、D-01・D-09     | 4時の前後・年越し・閏日、処理中の日付越境、二者確認の最後の時刻判定、次日の写真未作成状態                                                              | 撮影破棄UX、アプリ復帰、Schedulerと最終保存はP3・5・6                         |
| PS-04、PS-05、PS-06-001〜008                   | 承認済み写真だけ生成、同日二重作成拒否、同時FITの最新版本再判定、19+1+1で上限20、再試行、不成立時の不変性                                              | 実審査P3、近接・プレビュー・端末P5                                            |
| PS-07-002〜004、PS-18・PS-20の公開／非公開境界 | 本人表示のみ許可、他人・非参加・正本・安全対応・列挙・書込の拒否、画像取得、旧権限失効、本人ポインターの購読更新                                       | モバイル表示とローカルキャッシュP3・4・6                                      |
| PS-14、PS-17-017〜023、D-06                    | 過去写真の無地化・メタデータ削除・形状維持、削除後の本人FIT拒否、他者の成長、相互ブロック・通報者だけの無地化、停止主体拒否、削除／ブロックとFITの競合 | 利用者向け安全API・即時端末反映・物理削除・審査・監査・利用終了P4、Gallery P6 |
| PS-21、PS-27-017〜025                          | 3環境対応表の不正拒否、demo名前空間の分離、別環境トークン拒否、Auth・Functions Emulator、App CheckなしのHTTP拒否、独立配備物                           | 実3プロジェクト、IAM、正当な端末App Check、実配備・運用は未実施               |
| PS-22-011〜020                                 | バックエンド基盤・安全内部処理の実Emulator統合試験                                                                                                     | 通報キュー・通知対象・Galleryの全体試験はP4・6・7                             |

## 実サービス設定の未完了チェックリスト

以下は必要な手動作業であり、今回実行していない。プロジェクトID・課金・予算の決定後に進める。予算通知は支出の強制停止ではない。

1. development・staging・productionを**別のFirebase/GCPプロジェクト**で作る。Firestore／Storageのロケーションを作成前に確認し、Functionsの`asia-northeast1`との整合を確かめる。Blaze、予算通知、承認済み費用・maxInstances、必要なAPI、最小権限IAM・サービスアカウントを設定する。
2. Anonymous Authを有効化する。Gallery・削除権限を維持するため、匿名アカウントの自動削除は無効にする。既存サービスの設定を読むだけで完了扱いにしない。
3. 環境別のApp Checkを登録し、Callable・Firestore・Storageで実際の拒否を確認する。実アプリ登録、Bundle ID／Application ID、Apple／Androidの端末証明はPhase 3のDevelopment Buildと合わせて設定する。debug tokenを本番へ持ち込まない。
4. Firestore／Storage Rules、indexes、`fitSessions.expireAt`のTTLを配備する。Storage RulesからFirestoreを参照するサービス権限を確認する。実stagingで許可・未参加拒否・停止・ブロック・削除の取得失効を再試験する。[Emulatorと実環境の差](https://firebase.google.com/docs/emulator-suite/connect_firestore)
5. ローカルのGit対象外`firebase/projects.local.json`に、下記構造で実ID・予算承認・maxInstances・リージョンを記録し、`pnpm check:environment`で別プロジェクトであることを検査する。この検査はIAMや課金状態を照会しない。CLI配備ではこの対応表と明示的な`--project`を照合し、Functionsパラメーター`PUZZLE_PROJECT_ID`と`PUZZLE_MAX_INSTANCES`をその環境に設定する。`.env`や実設定はコミットしない。
6. `pnpm build`が作った`apps/functions/deploy`を単独の配備元にする。共有engine／contracts／Zodはbundleに含め、Firebase SDKは固定した独立npm lockfileからインストールする。パラメーター一致を含めてstagingでロード・正常要求・不正要求・ログの秘匿を確認する。production配備はP7のタグ＋手動承認ゲートまで行わない。

```json
{
  "development": {
    "projectId": "<実際のdevelopment ID>",
    "region": "asia-northeast1",
    "budgetApproved": true,
    "maxInstances": 1
  },
  "staging": {
    "projectId": "<実際のstaging ID>",
    "region": "asia-northeast1",
    "budgetApproved": true,
    "maxInstances": 1
  },
  "production": {
    "projectId": "<実際のproduction ID>",
    "region": "asia-northeast1",
    "budgetApproved": true,
    "maxInstances": 1
  }
}
```

上記`maxInstances: 1`は構造例であり、本番上限を決定したものではない。実サービスを使う前にG-BUDGET・E-CLOUDを通過する。Phase 3前には、名称・ワイヤー・画像仕様・入力制限・審査しきい値と保留UX、Xcode・Android環境の更新も必要。BLE/UWBの実機距離試験、法務・運営確認、外部ベータの安全ゲートは今回の成功に含めない。
