# Phase 3：日次写真と盤面

2026年10月10日（日本時間）。ローカル実装の記録。Phase 3のコードと自動試験を対象とし、実機・実Firebase・法務・外部公開の完了記録とは区別する。仕様原本は変更しない。

## 承認済みの初期方針

ユーザーへ一問ずつ確認し、次を承認された（実装計画D-10〜D-13）。

- 仮称は **puzzle-sns**。正式名称・ストア素材は後続の公開準備で確定する。
- 生成りの背景、墨色の文字、珊瑚色のアクセント。日本語はOS標準フォント。写真と固定向きのパズルを主役にし、生成時の短い演出は「動きを減らす」に対応する。
- 署名は20文字、キャプションは140文字まで。Unicodeの書記素単位で数え、NFC正規化・前後空白除去を両側で適用。空欄・署名の重複は許可。写真は正方形1024px、JPEG品質80%。通信入力の上限は5MiB、サーバーの展開上限は2500万画素。
- SafeSearchの成人・性的示唆・暴力がLIKELY以上なら拒否、POSSIBLEなら保留。テキストconfidenceが0.8以上なら拒否、0.5以上なら保留。連絡先・禁止語を拒否。不明は保留、障害時は未公開の再試行状態。保留画面は「確認中」。実審査の精度評価は公開前の必須ゲート。

禁止語の本番リスト・実サービスの判定精度・法務文書は未確定。Emulatorには「禁止語テスト」だけの人工ポリシーを使う。これを運営用リストとして配備しない。SafeSearchをCSAMの完全な検出器とは扱わない。

## 実装範囲

| 成果物                 | 内容                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`          | Expo Router、Development Build、匿名Auth／App Check、カメラ、前面・背面切替、撮り直し、正方形縮小、文章入力、最終確認、審査状態、Today、設定 |
| `packages/design`      | 配色、固定向きの256形状に対応するSVG輪郭。Skiaが同じ形状を描画・クリップ・ヒット判定する                                                     |
| `packages/contracts`   | 署名・文章・撮影セッション・同意・アップロードのstrictスキーマ。私的な審査状態や所有者対応は含めない                                         |
| Functions              | `acceptOnboarding`、`beginCapture`、`getCapture`、`uploadCapture`、`submitCapture`、非公開審査キュー、期限切れ掃除                           |
| `modules/installation` | Swift／Kotlinのバックアップ対象外インストール印。再インストール時は残存する本人認証・本人用情報を消し、消去成功後にだけ印を保存              |
| 自動試験・検査         | エンジンの既存試験を維持し、入力、審査分岐、画像処理、撮影トランザクション、端末状態管理、同意画面、環境設定を追加                           |

盤面はスケール・パンだけを行い、ピースや写真を回転しない。タップしたピースの写真・署名・キャプションを表示する。人数・プロフィール・交流履歴は表示しない。上限到達時は人数を表示せず完成を知らせる。

FIT操作はPhase 5、Gallery・通知・共有・SQLiteはPhase 6。利用者の通報／ブロック／削除／利用終了、運営審査・監査・問い合わせはPhase 4。安全基盤の権限失効と無地化は今回の購読・画像取得・表示にも適用する。未実装のボタンを動作する機能として見せず、外部ベータは開始しない。

## 画面と遷移

```text
初回起動 → 年齢の中立的な選択 → 利用文書への同意 → 署名（任意）
    ↓ サーバーの現在日付・同意版本を確認
カメラ許可説明 → 撮影 → 正方形プレビュー／撮り直し → キャプション
    ↓
最終確認（確定後の差し替え不可・二次共有の回収不可を説明）
    ↓ サーバーの本人撮影セッションへ送信。形状は未表示
確認中 ─ 合格 → 短いピース化 → Today（盤面、拡大・移動、タップ詳細）
       ├ 保留 → 「確認中」・非公開（人の処理はPhase 4）
       ├ 拒否 → 拒否を表示 → 撮り直し
       ├ 障害 → 同じ写真・文章で確認を再試行
       └ 4時越境 → 失効 → 新しい日の撮影
設定 → 次回の署名／カメラ権限／利用文書／バージョン／復元不可の説明
通信断・バックグラウンド → 今日の画像を消去 → 接続・前面復帰後に再取得
```

これをPhase 3の初期ワイヤーとする。Bluetooth・通知は説明だけで、権限要求と実操作は担当Phaseで実装する。正式ロゴ・完成した全画面のビジュアルレビューは未完了。実機で日本語の文字サイズ・小型画面・VoiceOver／TalkBack・動きを減らす・詳細モーダルのスクロールを確認する。

## 写真・審査・日付の境界

1. サーバーで本人の匿名認証、App Check、利用停止状態、16歳以上の申告、同意版本、日次の未確定状態を確認する。
2. 撮影セッションはサーバーの日付に固定し、次の日本時間4時に失効。同一日の未完了セッションを再利用する。入力は本人だけが取得でき、審査前にはピースID・形状を返さない。
3. 元画像はサイズ・JPEG署名を検査し、Callable経由でAdmin Storageへ保存する。**クライアントStorage SDKでの直接アップロードは許可しない**。Firebase SDKアップロードによる恒久ダウンロードトークンの作成を避けるための選択。5MiB以内のbase64だけを受け付け、ログへ本文を出さない。
4. SharpでJPEGの形式・展開サイズを検査し、向きを正規化して中央正方形へ切り出し、1024px・品質80で再処理する。EXIF等を残さない。破損・非JPEGは拒否して撮り直せる。
5. 完全な入力と正規化画像の両方をSafeSearchへ送る。空でない署名・キャプションはそれぞれ日本語`moderateText` v2へ送る。ローカルのNFKC・不可視文字／空白除去、電話・URL・SNS・禁止語チェックも適用する。検出の網羅性は保証せず、表記揺れと誤検出の実評価を残す。
6. 保留画像は再エンコード済みの非公開`review/`へ置き、非公開の`reviewQueue`へ追加。端末へキュー・他人の入力・内部対応を返さない。審査証拠の保存期間、4時失効案件の扱い、人による許可・拒否はPhase 4で確定する。
7. 合格画像は`normalized/`へ保存するが、この時点では画像ACLはない。最後にサーバー日付・主体状態・最新の処理leaseを再判定し、撮影セッションの確定、ピース／盤面／参加権限／表示／画像ACLを一つのFirestoreトランザクションで作成する。生成はサーバーの暗号学的乱数、クライアントの形状指定は拒否。
8. 同時要求・処理途中の終了・再試行でも日次のピースを増やさない。処理中の文章は固定し、変更した再試行を拒否。同一画像のStorage再保存はSHA-256と作成時のgeneration条件で冪等にする。既存画像の事前照合も行う。Storage EmulatorはGCSのgeneration条件を再現しなかったため、実stagingで異なる初回同時書き込みが置換されないことを必ず確認する。合格後の差し替え・削除後の同日再投稿はできない。
9. 処理完了後に元画像を削除。障害時は再試行のため4時まで保持する。削除失敗・期限切れ・未公開の正規化画像は非公開ジョブで掃除を再試行する。審査完了と期限切れ掃除が競合しても公開正本を壊さず、遅い保存後にもジョブを再登録する。掃除は一回100件・毎時であり、実サービスでは滞留監視・件数に応じた処理量の調整が必要。

元画像・審査画像・正規化画像に公開URLや恒久トークンを発行しない。配信は認証付きStorage `writeToFile`でアプリ専用キャッシュへ取得する。Storage Rulesの判定は従来どおり主体と画像ACLの2文書。

## 端末の保存・同期

- ネイティブFirebase匿名Authが本人認証を保持。SecureStoreに本人の署名・同意版本・撮影セッション・再試行用文章だけを保存する。他人の写真・署名・文章をSecureStoreへ保存しない。本人用削除キーの発行・利用はPhase 4。
- 日付はサーバー値を使う。端末時計は問い合わせ間隔のためだけに使用。前面復帰・通常の定期確認で日付を読み直し、投稿時はサーバーで4時を判定する。
- Todayはリアルタイムの本人用ポインターと閲覧者別DTOを購読。旧盤面のIDを流用せず、最新参加状態をサーバーで取り直す。Firestoreのディスク永続化を無効化し、キャッシュ由来のsnapshotは表示に使わない。
- 画像は取得世代ごとの専用ディレクトリ。遅い完了が旧画像を再表示しない。複数ダウンロードは全終了を待って掃除し、古い処理が新しい世代の画像を消さない。
- 通信断・背景移行・権限拒否・無地化を受信した時に画面・詳細・URIを消し、ファイルを削除。削除失敗でも画面を無地にし、次のプロセス起動でキャッシュ掃除を再試行。OS障害時の確実な物理消去や、ネットワーク通知前の即時遠隔消去を保証したとは扱わない。
- カメラの撮影元・縮小結果は撮り直し／画面終了で消去し、写真ライブラリーへ保存しない。異常終了時のカメラSDK一時ファイルの残存も実機確認項目とする。
- インストール印はiOS Application Supportのバックアップ除外フォルダ、Android `noBackupFilesDir`。新規印がない場合は残存Authをsign outし、本人用SecureStore項目・画像を消す。普通の更新では消さない。OSのバックアップ／クイック移行／アンインストールの違いは実機で必ず検証する。

## 依存とビルド

Expo **57.0.27**、React Native **0.86.3**、React **19.2.8**、React Native Firebase **26.4.0**、Skia **2.6.2**をlockfileで固定。Expo Goは使わない。[Expo SDK](https://docs.expo.dev/versions/latest/)・[ExpoとFirebase](https://docs.expo.dev/guides/using-firebase/)

iOSは静的frameworkリンクを維持し、Firebase SDKはSPMではなくCocoaPodsで解決する。登録ファイル設定済みの場合はFirebase公式Config Pluginの`ios.disableSPM: true`を使用する。未設定でもFirebaseのpodsは自動リンクされるため、その段階はローカルConfig Pluginで同じ`$RNFirebaseDisableSPM = true`をtarget宣言より前に挿入する。生成済みPodfileだけの手修正には依存しない。設定変更後は`pnpm --filter @puzzle-sns/mobile exec expo prebuild --platform ios --no-install`で反映してからnative runする。

workspaceでは依存のlifecycle scriptsを無効化しているため、初回インストール・依存再作成後は`pnpm --filter @puzzle-sns/mobile exec install-skia`で既存のSkiaバイナリを配置する。この処理は追加パッケージを取得しない。

Expoの推奨React 19.2.3より新しい同じ19.2系パッチを使用する。Router／jest-expoが使う`react-server-dom-webpack`とのpeerを合わせ、レジストリーで非推奨だった19.2.4を採用せず19.2.8に統一した。React／React DOMはExpo CLIの標準版本比較から明示的に除外し、同じ版本のtest rendererを使って型検査・UI試験・両OSのJS exportを実施する。ネイティブ互換性が実機確認済みという意味ではない。

strict TypeScriptは維持する。`unicode-segmenter`のCommonJS宣言がESM宣言を再exportする問題とRN／Node宣言の共存のため、contracts・全体検査・mobileでは外部宣言の検査だけ`skipLibCheck`を設定した。自分たちのコードの型検査は省略しない。エンジンはReact Native／Firebaseへ依存しない。Unicode処理も入力契約の側に置く。

Functionsの独立配備物にはcontracts・engine・Zod・Unicode処理を組み込み、Firebase／Google Cloud SDK／Sharpを外部依存として別lockfileで再現する。単独の別ディレクトリでロードと認可拒否を試験する。

## 実サービス・ネイティブ設定：初回実装時の未実施項目

今回はインストール済み環境の読み取り、プロジェクト依存の追加、ローカル試験だけを実施。Firebaseプロジェクト作成・ログイン・課金変更・API有効化・配備・EAS登録・署名・Xcode／Android Studio更新はしていない。

Phase 3初回調査時のMacはXcode **15.0.1**で、SDK57が要求する**26.4以上**に不足していた。2026年10月11日の実機ビルド設定修正時には選択先が**27.0**になったことを確認した。Android SDK platform36と実サービス設定は別途確認が必要。`pnpm check:mobile`は読み取りのみの検査で、初回調査では設定・Xcode・SDKの不足を報告して終了コード2だった。成功済みの自動試験とは別の未通過ゲート。

1. [PHASE2.md](PHASE2.md)の実3環境、課金上限、IAM、匿名Auth、自動削除無効、Rules、リージョンを整える。development／staging／productionは別Firebaseプロジェクトとする。
2. 開発用・検証用のiOS／Androidアプリを登録する。暫定bundle/packageは `jp.puzzlesns.app.development` と `jp.puzzlesns.app.staging`。登録ファイルのプロジェクトIDとアプリIDは検査する。正式ドメイン・ストア識別子は公開前に確定する。
3. `apps/mobile/mobile.config.local.json`（Git対象外）にdevelopment／stagingごとの`projectId`、`iosServices`（plistのパス）、`androidServices`（JSONのパス）、`legal`（version、terms、privacy、communityのHTTPS URL）を設定する。任意で`icon`と`easProjectId`（EAS登録のUUID、Firebase projectIdとは別）、developmentのみ`emulatorHost`を設定する。設定内で同じprojectIdやstagingのEmulatorを使うと拒否する。秘密トークンを`extra`やJSへ書かない。
4. 実利用文書とサーバーの`PUZZLE_LEGAL_VERSION`を合わせる。URL・版本が未設定ならアプリを開始できない。文書初稿は当初Phase 4予定だったが、2026年10月27日にユーザーが文書作成だけの前倒しを承認し、[初稿とレビュー事項](legal/README.md)を作成した。初稿は未発効・未接続。公開版の専門家確認はPhase 7のゲートとして維持し、ダミーの法務文書で同意済みとしない。
5. App Checkを設定する。developmentはネイティブdebug providerの正規登録、stagingはPlay Integrity／App Attest＋DeviceCheck fallback。実機で正当tokenの取得と各サービスの強制を確認する。[React Native Firebase App Check](https://rnfirebase.io/app-check/usage)
6. Vision・Natural Language v2のAPI・サービス課金・最小IAM・非公開Storageを設定する。これらの処理地域・国外処理は利用文書で法務確認する。画像の展開メモリを抑えるためCallableは512MiB・concurrency1・timeout180秒とし、実負荷試験はPhase 7に残す。Functionsに`PUZZLE_PROJECT_ID`、`PUZZLE_MAX_INSTANCES`、`PUZZLE_STORAGE_BUCKET`、`PUZZLE_LEGAL_VERSION`、JSON文字列`PUZZLE_MODERATION_POLICY`（textHold、textReject、bannedWords）を設定。承認値0.5／0.8、レビュー済み禁止語を使用する。Vision／NLは自動試験では外部へ呼んでいない。[Natural Language v2](https://docs.cloud.google.com/natural-language/docs/reference/rest/v2/documents/moderateText)
7. Schedulerの毎時`cleanupCaptures`を設定し、期限切れ・削除失敗・孤立画像の滞留を監視する。本番利用前に匿名主体・撮り直し要求・アップロードの回数制限と料金監視をPhase 7で評価・実装する。これはPhase 6の4時作品固定workerを実装したものではない。保存期間表と審査キューの運営処理はPhase 4で完成させる。
8. 空き容量を確保し、Xcode26.4以上・Android Studio／SDK36を準備する。AndroidビルドはJDK17、EmulatorはJDK21を使い分ける。必要なら利用するビルドツールの当時の公式要件を再確認する。
9. EAS CLIを導入・固定し、EASプロジェクト・署名を登録する。`eas.json`には内部Development Buildのdevelopment／stagingだけを置き、productionプロファイルは追加していない。productionのAPP_ENV指定も拒否する。外部EAS実行は今回していない。

設定・環境の準備後の確認コマンド：

```sh
pnpm check:mobile
pnpm --filter @puzzle-sns/mobile exec expo install --check
pnpm --filter @puzzle-sns/mobile exec expo run:ios
# AndroidはJDK17とSDK36を選択して実行
pnpm --filter @puzzle-sns/mobile exec expo run:android
pnpm --filter @puzzle-sns/mobile start
```

上記native runはprebuild・ネイティブ生成・依存インストールを伴う。実行前にローカル設定と署名を準備する。初回実装では未実行。2026年10月11日のビルド設定修正ではiOSのprebuildとPodfileのRuby構文検査が成功し、通常118件・Emulator37件の再検査も成功した。iOSの実機ビルド・起動の追試は下記に記録する。Emulator接続でもApp Checkを偽造・無効化せず、正規のネイティブ設定が必要。審査の本番アダプターはVision／NLを使うため、ローカル統合試験の人工PhotoProcessorを実アプリへ切り替える機能は提供しない。

上記は既存のクラウド接続経路の方針である。2026年10月27日のユーザーの実装優先・計画作成依頼を受け、本人用の[ローカル実機開発計画](PHASE3_LOCAL_PLAN.md)を別途提案した。仮審査・App Check・内部検証の開始確認の差分を明記している。10月28日の実装依頼に基づき、手順1〜5の専用アプリ・全Emulator・匿名認証・人工素材の撮影・Macでの仮審査と画像保存・写真入りTodayと詳細までを接続した。[起動手順と確認範囲](PHASE3_LOCAL_SETUP.md)を参照する。画像正規化・Storage I/Oを共有モジュールへ分離したが、通常経路の認可・実審査・同意の条件は維持している。手順5では切断時の非表示・再接続と、ローカル限定の初期化コマンドを追加した。個別の実機確認範囲は起動手順に記録する。

## 実機起動の追試（2026年10月12日、日本時間）

- Xcode 27.0でiOS Debugビルドが成功。CocoaPodsの依存解決、ネイティブリンク、開発用署名、端末へのインストールを確認した。
- iPhone 16（iOS 26.5.2）で、ユーザーがDeveloper Mode・開発者の信頼・Macの署名キー使用許可を操作した後、`devicectl`による起動が成功した。
- ユーザーの回答で、Metroから読み込んだアプリに「Firebaseなどの設定が必要」という画面が表示されたことを確認した。未設定時の拒否画面の確認であり、撮影・投稿・審査・Skia盤面の実機合格ではない。
- Android SDK platform 36（revision 2）を導入し、`android.jar`とAPI level 36を確認した。ライセンスへの自動同意は行っていない。再実行した`pnpm check:mobile`の未完了項目はFirebase登録ファイル／利用文書設定のみ。Androidのネイティブビルドと実機確認は別途必要。
- Firebase CLIにはログイン登録が1件あるが、実プロジェクト一覧の読み取りは401で失敗した。再認証が必要であり、プロジェクトが存在しないとは断定しない。
- 実プロジェクトの作成、課金接続、API有効化、配備は未実施。Phase 4には進んでいない。次の設定手順と投稿の実機確認は[PHASE3_SETUP.md](PHASE3_SETUP.md)を参照する。

## 自動検証と未検証の区別

初回実装では整形・Lint・型検査、通常117件（サーバー／共通98件・モバイル19件）、Emulator37件が成功。配備物ロード、両OS向けJS/Hermes export、frozen lockfile再現、Expoの依存比較も成功した。React／React DOMは明示した除外を含む。Swift構文、podspecのRuby構文、両OSの自動リンク検出も確認した。これらの自動検査だけをネイティブリンク・実機起動・距離精度の証明とは扱わない。

2026年10月12日の再検査でも整形・Lint・型検査、通常118件（サーバー／共通98件・モバイル20件）、Emulator37件が成功した。1件の増加はFirebaseのCocoaPods選択に対する回帰試験。iOSのネイティブリンク・実機起動は上記の追試で確認済み。Androidのネイティブリンク・投稿フローの実機試験・実Google審査は未確認である。

| 検証対象   | 自動試験                                                                    | 必須の手動確認                                                                              |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 日次投稿   | 同意、所有者、同日一枚、同時要求、再試行、4時中断、掃除との競合             | 実アプリ・実時刻での4時越境、端末時計改変、終了／再起動                                     |
| 審査       | しきい値、不明、保留、障害、連絡先の人工例、入力と再処理画像の両方          | 日本語短文・隠語・連絡先の網羅性、誤拒否／誤許可、運営レビュー用の評価票                    |
| 画像       | 人工JPEG、サイズ・形式・破損、1024正方形、EXIF除去、保存冪等性・token不発行 | 前後カメラ・向き・光量・実端末のEXIF、Googleサービスの実判定、ストレージの実IAM             |
| 盤面       | 全256輪郭、DTO、購読変更、旧取得の破棄、無地化、通信断                      | Skia描画、タップ・ピンチ・パン、20ピース／穴・細長い形、小型画面、フレーム性能              |
| 初回・保存 | 年齢／同意UI、未設定拒否、環境分離、インストール消去の順序と失敗            | Auth・App Check、バックアップ・更新・アンインストール・再導入、Keychain、ディスクキャッシュ |

実機チェックでは**人工図形を印刷／別画面表示して撮影**し、実利用者の写真を試験素材にしない。結果をOS・端末・アプリ版本・日時・合否・再現方法で記録する。実機、実審査、利用文書と運営の必須項目が終わるまでは、Phase 3全体の完了や外部公開可能とは扱わない。Phase 4にはまだ進んでいない。
