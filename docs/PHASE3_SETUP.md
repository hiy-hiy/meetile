# Phase 3：実サービス接続と実機確認

更新：2026年10月27日、日本時間。開発者本人の内部検証用。Phase 4の安全機能・管理画面が未完成なので、外部利用者へ配布しない。

## 現在地

iPhone 16／iOS 26.5.2でビルド・署名・インストール・起動・Metroからの未設定画面表示は成功（10月12日の記録）。Android SDK36（revision 2）を導入済み。Androidのネイティブビルド・実機検証は未完了。

10月27日にFirebase CLIを再認証し、既存の別アプリ用プロジェクトを読み取り確認した。専用のdevelopmentプロジェクトをSparkプランで作成し、iOS／Androidの`jp.puzzlesns.app.development`を登録した。登録ファイルはGit対象外の`apps/mobile/GoogleService-Info.plist`・`apps/mobile/google-services.json`へ保存した。CLIのAuth設定により補助用のDefault Web Appも作成されたが、製品にWebクライアントは追加していない。

**予算方針は月額0円。課金先は接続しない。** Cloud Billing APIで`billingEnabled: false`を確認した。匿名Authを有効化し、プロビジョニング時に有効だった匿名ユーザーの自動削除を無効へ修正して再取得確認した。Firestoreは`asia-northeast1`・Standard・無料枠対象の`(default)`を作成し、PITRは無効。初期の拒否ルールを維持し、製品用Rules・indexesは未配備。

実サービスで匿名ログイン成功・テスト主体の削除成功・認証なしのFirestore文書取得の403拒否を確認した。これは製品用Rules・App Check・実機からの認証の合格ではない。実IDと進捗はGit対象外の`.tools/firebase-spark-state.json`に保存した。staging／productionは未作成であり、3環境と有料サービス用予算承認を要求する`firebase/projects.local.json`はまだ作成していない。

Storage・Functions・Vision／Natural Language・App Check・実利用文書の確定版・モバイル接続設定・登録ファイルを反映したネイティブ再ビルドは未完了。実機投稿はまだできない。0円条件下では課金を必要とするサービスへの接続を進めず、Mac内のEmulator検証を利用する。実審査を省略して投稿可能にする変更は行わない。

10月27日の検証：整形・Lint・型検査、通常テスト118件、Emulatorテスト37件が成功した。取得した両OSの登録ファイルのproject IDとBundle／Application IDも既存検証関数で照合した。Emulator検査の初回は誤ったJavaのPATH指定で起動前に停止し、既存のJDK 21を使って再実行して成功した。`pnpm check:mobile`はモバイル接続設定・HTTPS利用文書が未設定のため想定どおり終了コード2。アプリの製品動作・仕様原本を変更せず、取得した登録ファイルとローカル進捗がGit対象外であることを確認した。実機再ビルド・撮影・審査・Todayの一連の確認は未実施。

## 利用文書の初稿（2026年10月27日）

ユーザーが利用文書作成だけの前倒しを承認したため、[利用文書の初稿3点とレビュー事項](legal/README.md)を作成した。対象は完成後のMVP仕様で、草案セットは`draft-2026-10-27.1`。運営者情報、窓口、未成年者の同意、保存期間、国外取扱い、権利許諾等を未確定事項として明示した。初期化時の認証・App Checkが年齢申告・同意前に通信する既存設計もレビュー対象に含めた。

初稿は内部レビュー用・未発効であり、実際に利用者が同意する文書の設定完了とは扱わない。HTTPSでの公開、`legal.version`／`PUZZLE_LEGAL_VERSION`の設定、アプリでの同意取得、法務・運営・実機ゲートの通過は未実施。Phase 4の安全機能実装には進んでいない。

初稿追加後の検証：整形・Lint・型検査、通常テスト118件・Emulatorテスト37件が成功した。文書5点の相対リンク、草案セットの一致、レビューID12件と要確定箇所の参照、未発効表示、ダミーURLを含まないことを検査した。作業前の内容との比較と原本2点のSHA-256照合で、今回の変更が文書と案内・記録に限られることを確認した。専門家による文案確認、運営情報の確定、公開ページと実機での同意確認は未実施。

## 保存・削除方針の照合（2026年10月27日）

利用文書の保存・削除方針については、L-04・L-06の[実装照合と検討案](legal/DATA_RETENTION_REVIEW.md)を作成した。画像削除以外に残る文章・表示コピー、保留審査、利用終了と委託先保持の範囲を整理したが、保存日数・消去期限・例外は未決定。今回も文書のみの作業で、削除処理・TTL・クラウド設定は変更していない。

照合資料追加後も整形・Lint・型検査、通常118件・Emulator37件のテストが成功した。文書の相対リンクと、作業前の原本・ソース・Rules等のハッシュ一致を確認した。全コピーの消去、保存期限の実運用、委託先保持設定、実機への削除反映の合格を示すものではない。

## 次の実装候補：ローカル実機開発モード

ユーザーは、運用・法務文書の確定をすべて先に行うのではなく、まず動くアプリを作り、その実装計画をまとめるよう依頼した。[Phase 3ローカル開発計画](PHASE3_LOCAL_PLAN.md)に、1人分の撮影からTodayまでをMacとiPhoneで通す案を整理した。予算0円、固定demo project、通常版と別の識別子・入口・配備物を前提とする。

既存のクラウド経路で必要な実審査・App Check・正式文書とは区別し、ローカル限定の仮審査・App Check非要求・内部検証確認を提案している。今回は計画のみで、アプリ・サーバー・起動コマンド・Firebase設定は変更していない。以下は引き続き実クラウドへ接続する場合の手順であり、ローカル計画の全前提ではない。

## 実クラウド接続までの順番

1. **Googleアカウントと予算を決める。** CLIを再認証し、既存プロジェクトを読み取り確認する。計画書G-BUDGETの開発用月額予算・警告先・停止判断を記録してから課金サービスへ接続する。予算通知は請求額を自動停止する上限ではない。[Firebaseの予算通知](https://firebase.google.com/docs/projects/billing/budget-alerts)
2. **環境を分ける。** development／staging／productionは別プロジェクト。最初の端末接続と配備先はdevelopmentだけにする。東京対応サービスは`asia-northeast1`。Firestore・Storageのロケーションは作成前に確認する。実IDなどはGit対象外の`firebase/projects.local.json`へ記録する。productionへは配備しない。
3. **Firebaseと審査を設定する。** developmentに匿名Auth（自動削除無効）、Firestore、非公開Storage、iOS／Androidアプリを登録する。アプリIDは`jp.puzzlesns.app.development`。Functions・Storageの利用にはBlazeと課金アカウントが必要。[料金プラン](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)・[Storageの課金要件](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)。Vision／Natural Language v2を有効化し、実行主体に必要な権限だけを与える。
4. **利用文書と審査ポリシーを用意する。** 実際に読める利用規約・プライバシーポリシー・コミュニティガイドラインのHTTPS URLと版本、開発検証用として確認した禁止語リストが必要。しきい値は承認済みの0.5／0.8。試験専用の「禁止語テスト」を運営ポリシーとして配備しない。初稿作成だけの前倒しは10月27日に承認され、上記の草案を作成済み。確定版と実URLは未準備。仮URLや同意の迂回は使用しない。
5. **ローカル設定・Rules・Functionsを接続する。** 登録ファイルと`apps/mobile/mobile.config.local.json`はGit対象外。Functionsには実project ID・bucket・文書版本・審査ポリシー・承認済みの`maxInstances`を設定する。現コードの`minInstances`は0、Callableは512MiB／concurrency 1。`maxInstances`は各関数の上限であり、プロジェクト全体の課金上限ではない。検査・ビルド後にdevelopmentへRules・indexes・Functionsを配備し、TTL・掃除・StorageからFirestoreへの参照権限を確認する。
6. **App Checkを登録して再ビルドする。** developmentのdebug providerで端末に発行された秘密トークンをFirebaseコンソールへ登録する。トークンをチャット・Git・JSの`extra`へ貼らない。Callable・Firestore・StorageのApp CheckとRulesを有効にし、正当要求の成功と不正要求の拒否を確認する。[App Checkの設定](https://rnfirebase.io/app-check/usage)。登録ファイルを反映してiOSを再ビルドする。

登録ファイルと設定キーの詳細は[PHASE3.md](PHASE3.md)、環境・権限の詳細は[PHASE2.md](PHASE2.md)を参照する。上記は作業順であり、クラウド設定済み・利用文書承認済みという記録ではない。

## 接続後に本人が行う最小の実機確認

実利用者の写真を使わず、人工図形を別画面に表示または印刷して撮影する。

1. 年齢・利用文書・署名の画面を確認する。16歳未満では開始できないこと、署名の空欄が許可されることを確認する。
2. カメラ権限を拒否して案内を確認し、許可後に前面／背面切替と撮り直しを試す。
3. 人工図形を撮影し、安全な短文を入力して確定する。「確認中」からピース化し、Todayに1枚だけ表示されることを確認する。
4. ピースをタップし、写真・署名・文章を確認する。盤面を拡大・移動し、再起動しても同じ写真・形状が表示され、差し替え・同日再撮影ができないことを確認する。
5. バックグラウンド移行と通信断でTodayの写真が消え、前面・通信復帰でサーバーから再取得されることを確認する。

結果は端末・OS・日時・合否と一緒に記録する。審査の拒否／保留／障害、4時境界、20ピース形状、キャッシュ・再インストール、Android、実stagingの競合・権限も別途確認が必要。上記5項目だけでPhase 3全体や外部公開の合格にしない。
