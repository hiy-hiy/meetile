# Phase 5-4a：AndroidのBLE・共通GATT

作成：2026年10月30日（日本時間）。[詳細設計](PHASE5_ANDROID_DESIGN.md)の5-4aをローカル実装した。**Android同士・iPhoneとの相互通信、FIT一周、距離精度は未確認**。UWB・OOBは5-4bに残し、Phase 5全体の完了とは扱わない。

現在の5-4bの能力値・追加特性・UWBは[実装記録](PHASE5_ANDROID_UWB.md)を参照。以下は5-4a時点の記録で、flags=0・OOB未提供はその時点の状態。

## 実装内容

`apps/mobile/modules/proximity/android/`にExpoの`Proximity`モジュールを追加した。アプリ生成フォルダーへ実装を残さず、既存のSwift版・サーバーAPIと並存する。

- `ProximityModule.kt`：開始・停止、Bluetoothの3権限、packageとサービスUUID・local Debug印の照合。Activityのpause・window focus喪失・破棄で即座にトークンの利用を無効化する。権限結果や古い停止要求から探索を再開しない。
- `FitRadio.kt`：前面でのlegacy広告と探索、GATT server/client、RSSI、短期トークンの読み取り・再読。接続可能な広告には固定サービスUUIDだけを載せ、端末名・写真・署名・安全ID・トークンを載せない。
- `FitWire.kt`・`FitState.kt`：iOSと同じ16バイト／base64urlの正規形、READオフセット、45秒の保守的な利用上限、接続ごとの操作待ち、未読・変更されたトークンの状態。OSの端末識別子はJSへ渡さず、探索中だけのハンドルを使う。
- Bluetooth APIのcallbackを専用の直列キューへ集め、古いradio／GATTと別操作の応答を無視する。接続・操作にtimeoutと再試行間隔を設け、候補数・同時接続数を制限する。未読・未接続の候補もRSSI観測に含め、上限を越えたままFITを許可しない。
- `expo-module.config.json`と`factory.ts`：Androidを登録し、明示された開発用疑似近接か、実ネイティブ通信を選ぶ。
- `policy.ts`：観測を時刻順に扱い、同時刻は受信順とする。最新の観測が`token: null`なら、過去の非nullトークンを再利用しない。nullでも複数候補判定から除外しない。

近接しきい値・保持時間と、サーバーの日付・トークン期限・相互検知・双方確認・盤面統合・削除・認可は変更していない。BLEで正確な10cmを保証しない。GPS・位置履歴・位置情報権限・Foreground Service・バックグラウンド探索・Bluetooth自動ON・永続ペアリングは追加していない。

## GATTと権限

共通UUIDの末尾は`-0E40-4CB6-AF31-8B034F29A718`。サービスUUIDは[iOSの既存表](PHASE5_IOS.md#androidへ引き継ぐgatt形式)と同一。

| 特性prefix | 5-4aの動作                                                                     |
| ---------- | ------------------------------------------------------------------------------ |
| `BD1E1001` | READで現在のFITトークン16バイト                                                |
| `BD1E1002` | READで空。AndroidはAppleのNIアーカイブを復号しない                             |
| `BD1E1003` | READで`version=1 / flags=0 / token:16 bytes`。UWBとOOBが未実装であることを返す |
| `BD1E1004` | 未提供。5-4bで追加する                                                         |

READはオフセットとMTUを確認し、WRITE・prepared write・descriptor書き込みは拒否する。停止・保守的期限後はトークン応答を開始せず、GATTと広告・探索を終了する。

Manifestには`BLUETOOTH_SCAN`（`neverForLocation`）・`BLUETOOTH_ADVERTISE`・`BLUETOOTH_CONNECT`と任意のBLE featureを宣言した。RANGINGは今回要求しない。権限ダイアログで前面から外れた場合、付与後も再試行が必要になる。拒否・再要求・メーカー別の違いは実機試験に残す。

## ビルドと自動検査

[起動準備](PHASE5_ANDROID_SETUP.md)に従い、SDK 36・JDK 17・ローカル設定を用意する。通常のMacサーバーとEmulator試験のターミナルはJDK 21を維持する。

```sh
PROXIMITY_MODE=native pnpm local:android --build-only
pnpm test:proximity:android
# 端末へ入れて実通信を選ぶ場合
PROXIMITY_MODE=native pnpm local:android --device <Androidの端末名>
```

`test:proximity:android`は生成済みAndroidプロジェクトの`:proximity:testDebugUnitTest`を実行する。生成前・モジュール登録変更後は先にbuild-onlyを行う。JVMテスト用のJUnit 4.13.2だけを追加し、実アプリのランタイム依存は追加していない。

2026年10月30日の結果：

- 整形・Lint・TypeScript型検査と依存境界：成功。
- `pnpm test`：共通・サーバー110件、モバイル158件、Nodeスクリプト9件の計277件が成功。最新null・再読・同時刻・順序の遅れ・Android選択・疑似近接の条件を含む。
- `pnpm test:emulators`：12スイート115件が成功。既存のサーバー・認可・同時FIT・安全処理の回帰を確認。
- `pnpm test:proximity:android`：7件が成功。トークン正規形、256種類のバイト列、READ範囲と空NI、期限・停止、コピー保持、操作の順序と古い接続のcallback拒否、peerトークン変更を検証。Bluetooth APIの実通信を再現する試験ではない。
- `PROXIMITY_MODE=native pnpm local:android --build-only`：ARM64 Debugビルドが成功。Expoブリッジを含むコンパイル・リンクとAPK生成を確認。生成ManifestのBluetooth権限・`neverForLocation`・位置情報権限の不在を確認。
- `pnpm test:proximity:ios`：iOS SDK型検査と共通GATT形式試験が成功。
- `pnpm check:local-boundaries`：通常版iOS／AndroidバンドルとFunctionsへのローカル専用コード非混入を確認。

## Android 13実機の確認範囲

OPPO PDRM00（API 33）へDebug APKを更新インストールして起動した。既存の保存データ・開始確認は消去していない。既存のMetro（8082）を残し、確認用に8083で`PROXIMITY_MODE=native`のMetroを起動した。manifestの`simulatedProximity=false`と、実機での`Proximity`登録を確認した。

確認は開発版のインスペクターから実ネイティブモジュールへ合成トークンを渡す単体試験として実施した。サーバーのFIT発行・相互報告・確認・盤面変更は呼び出していない。年齢申告・開始確認・撮影も行っていない。これは本人によるFIT画面操作や、製品フロー一周の合格とは区別する。

| 項目                | 実機での結果                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 初回Bluetooth権限   | OSの「近くのデバイス」ダイアログを確認。フォーカス喪失で`interrupted`になり、許可結果だけでは再開しなかった。確認中に3権限を許可した |
| 開始時Bluetooth OFF | 権限付与後の再試行で`bluetooth-off`を受信                                                                                            |
| 広告・探索開始      | Bluetoothを一時ONにして開始。開始失敗イベントがなく、OSのlow latencyスキャン開始記録を確認                                           |
| 45秒の保守的期限    | JSから更新しない単体試験で約45秒後に`interrupted`となり、OSの開始／停止記録が一致した                                                |
| 古い停止要求        | 新しい試行の開始後に前のrunIdでstopしても、新しいOSスキャンが継続した                                                                |
| ホームへ移動        | 開始約3.4秒でホームへ移動し、`interrupted`とスキャン停止を確認。45秒期限の停止とは別に測定                                           |
| 前面へ復帰          | 既存Activityへ復帰してもスキャンの開始件数は増えず、自動再開しなかった                                                               |
| 探索中Bluetooth OFF | 別の試行を開始し、約3.8秒後のBluetooth OFFで`bluetooth-off`となって停止した                                                          |

相手端末を使わない試験であり、観測されたpeerは0件。GATTのトークン交換・READ拒否を別端末から確認したことにはならない。確認後はネイティブ試行とテスト用イベント購読を終了し、Bluetoothを元のOFFへ戻した。確認中に付与したアプリのBluetooth権限は許可済みのまま。権限の拒否・取消は未確認。

確認用Metro（8083）は終了し、アプリは既存のローカルMetro（8082）へ戻して起動した。既存のMacサーバーと保存データは維持した。次に実通信を試す際は、上記コマンドの`PROXIMITY_MODE=native`を明示してMetroも同じ設定で起動する。

## 未確認・次の単位

- Android同士・iPhoneとのBLE広告受信・相互GATT・トークン再読、双方確認からFIT結果まで。
- 3台以上、混雑・遮蔽、`neverForLocation`による除外、権限拒否・取消、画面ロック、旧OS・他機種、30秒更新、4時境界、切断後の表示と再試行。
- UWB・Ranging API・OOB転送は5-4b。5-4aの成功をAndroid UWBの合格として扱わない。
- G-PROXの合格基準は測定前に確定する。近接距離・誤接続率は未評価。実機を確保できるまで測定完了時期は見積もり困難。
- 実クラウド・App Check・安全運用・法務・外部公開ゲートは従来どおり維持する。

編集前のソースをGit対象外の`.tools/phase5-4a-baseline/`へ保存し、既存ファイルとの差分・新規コードを確認する。仕様原本・AGENTS.mdは変更していない。秘密情報・BLEトークン・Bluetoothアドレスを製品ログや保存領域へ記録する処理は追加していない。

5-4bは[ローカル実装済み](PHASE5_ANDROID_UWB.md)。次の単位は5-5の実機試験準備。相互通信・距離精度の未確認は継続する。
