# Phase 5-4b：Androidの能力交換・OOB・UWB

作成：2026年10月30日（日本時間）。[Android詳細設計](PHASE5_ANDROID_DESIGN.md)の5-4bをローカル実装した。**Android 16の実端末間のOOB・UWB、距離精度、FIT一周は未確認**。Phase 5全体の受け入れ・外部公開の条件は満たしていない。製品仕様・サーバーの正本・FIT条件は変更しない。

## 実装

- `FitWire.kt`：共通GATTの能力値とOOB特性UUID。能力は固定18バイトで、現在のFITトークンに結び付ける。未知version・flags・長さ、トークン不一致はUWBに使わない。
- `FitOobWire.kt`：10バイトヘッダー、HELLO／READY／DATA／ABORT、MTUに応じた分割・再組み立て、write応答待ち、重複・順序・容量・期限の検査。
- `FitOobSession.kt`：符号なしトークン比較による役割、両役割の開始順、SDK登録前データの保持、距離の鮮度、UWBを閉じてからBLEへ戻る状態遷移。
- `FitRangingPort.kt`：API 36の型を含まない境界と、SDKのスレッドからradioの直列処理へ渡すtransport。SDK指定Executorが並列でも、受信は一つのdrainで順番を維持する。再登録・close以前の待機通知を無効化する。SDKへ渡した受信配列はSDKへ所有権を渡し、その場で消去しない。
- `FitRangingApi36.kt`：SDK 36の標準OOB `TransportHandle`・`DeviceHandle`・`RangingSession`。API・権限・端末機能を確認した経路だけで生成する。
- `FitRadio.kt`：GATT server/clientへの接続、能力確認、候補選択、双方向のWRITE with response、停止処理。`ProximityModule.kt`とManifestに条件付きのRANGING権限要求を追加した。

Android 16以上・RANGING許可・UWB機能・OSのUWB ENABLED・距離測定対応を満たした場合だけflags=3を返す。旧OS、権限拒否、利用不可ではflags=0でBLEを続ける。能力応答待ちは最大5秒で、その間は広告開始を保留する。BLEへの復帰後は同じ試行中にUWBへ再昇格しない。Android–iPhoneも共通GATTのBLEを維持し、UWB RAW方式は追加していない。

UWBはHIGH_ACCURACY・SECURE、要求間隔100〜500 ms、角度取得なし。UWB以外の開始・結果を拒否する。SDK 36には技術filterのsetterがないため、Android 16のAOSPがHIGH_ACCURACYでUWBだけを選ぶことに基づく判断は[詳細設計§6](PHASE5_ANDROID_DESIGN.md#6-ranging-apiの開始条件と役割)に残した。結果のtimestampはwall clockのため、到着時に0〜1秒の範囲を確認し、その後は単調時計で鮮度を管理する。距離の単位はメートル。

## プロトコルと停止の補足

- 送受信者の現在の16バイトトークンを両方照合し、本人確認やBLEアドレスを認証の代わりにはしない。トークンの内容・アドレス・OOB payloadはログや永続領域へ保存しない。
- OOB payloadは1〜4096バイト。メッセージは一方向32件、送信待ちは8件、受信組み立ては4接続・各2秒まで。MTU 23でも分割でき、一回のwriteは`min(MTU - 3, 512)`バイト以内にする。
- 相手が先にREADを完了した場合、HELLOだけを最大4件・2秒保持する。逆方向の接続でも相手トークンと能力を読み、候補が一人になってからSDKを開始する。生きたセッションの受信接続を別接続へ付け替えない。
- responderのSDK callback登録後にREADYを送り、その後にSDK DATAを送る。APIが登録前に送信してもこの順番を維持し、callback再登録でREADYを重複送信しない。
- 開始待ちは候補選択から5秒。複数候補で選べない場合も5秒でBLEへ戻す。測距中に別候補が見える、距離が1秒古くなる、切断・不正な転送・権限撤回・SDK失敗が起きるとUWBを閉じる。判定不能中はtoken=nullで候補の存在を残し、既存の最新token条件でFITを止める。
- SDK transportの恒久切断はcloseとして通知し、自動再接続は実装しない。ABORT受信は扱うが、停止時にABORTの送達を待たずローカルのSDK・GATTを閉じる。前面離脱・45秒上限・JS停止時の制御は維持する。

この補足は詳細設計のスレッド・開始順・停止方法を具体化したもの。距離しきい値・サーバー認可・対象端末などの製品ルールの変更ではない。

## 確認結果

- `pnpm format:check`・`pnpm lint`・`pnpm typecheck`：成功。Gradleが生成するテストreportのJavaScriptがLint対象に入ったため、モジュールの`android/build`・`.gradle`だけを除外した。
- `pnpm test`：277件成功。`pnpm test:emulators`：115件成功。
- Androidネイティブ：19件成功（既存7件・OOB関連12件）。MTU 23／185／517、payload上限、正しい直前断片の再送、順序・偽token・timeout・上限、両役割、SDK登録前送信、並列Executorの受信順、再登録・close後の通知、距離の失効、入力配列のコピーを確認。実距離を検証する試験ではない。
- SDK 36・JDK 17によるARM64 Debugビルド：prebuildからのビルドと、最終ソースでのAPK再ビルド・ネイティブ試験が成功。
- `pnpm test:proximity:ios`：既存のwire試験・SDK型検査が成功。iOS実機通信とは区別する。
- Android 13（API 33）の接続済み実機：更新インストール・起動・JSからのネイティブモジュール読み込みを確認。ADB接続断の後に復帰し、人工トークンでnative startを実行した。OSの自アプリ探索回数が開始1／停止0になり、ホーム移動後は開始1／停止1、`interrupted`通知を確認した。API 36非利用の開始経路の単体確認で、相手とのGATT・距離精度は未確認。Bluetoothを一時的にONにして元のOFFへ戻した。人工トークンの試行を停止し、既存のMetro（8082）へ起動先を戻し、今回だけのMetro（8083）を終了した。年齢・開始同意・撮影・サーバーFIT操作は行っていない。

Gitは初回コミット前のため、変更前のソースをGit対象外の`.tools/phase5-4b-baseline/`へ保存し、差分を確認した。AGENTS.mdとPRODUCT_SPEC.mdは保存済みハッシュと一致した。クラウドへのデプロイ・実ユーザー写真の利用は行っていない。

## 次に残すこと

5-5aの[実機試験準備](PHASE5_DEVICE_TEST_PLAN.md)は整備済み。次はローカル開発専用の方式・停止状態の観測手段を整え、その後既存2台の混在BLE実通信を確認する。利用可能端末と組み合わせ、G-PROXの合格基準案、記録様式・手順は同記録を参照。合格基準は測定前に確定し、未承認の数値を合格基準として使わない。

Android 16以上のUWB対応2台で標準OOB・双方の役割・距離更新・停止・BLE復帰を確かめる。旧Android、iPhone混在、3台以上、遮蔽・混雑、各権限の拒否・撤回も必要。BLEを正確な10 cmの保証とは表現しない。用意できない端末・組み合わせは未確認のまま残す。

推奨：Claude CodeはOpus 5.5・Effort High、CodexはGPT-6.1 Sol・High。重点レビューも同じ設定。誤接続・鮮度・複数候補と、測定結果を合格と扱う条件を一緒に確認するため。

APIの一次資料：[Android Ranging](https://developer.android.com/develop/connectivity/ranging)、[TransportHandle](https://developer.android.com/reference/android/ranging/oob/TransportHandle)、[AOSP RangingSession](https://android.googlesource.com/platform/packages/modules/Uwb/+/refs/heads/android16-release/ranging/framework/java/android/ranging/RangingSession.java)、[RangingData](https://android.googlesource.com/platform/packages/modules/Uwb/+/refs/heads/android16-release/ranging/framework/java/android/ranging/RangingData.java)、[RangingMeasurement](https://android.googlesource.com/platform/packages/modules/Uwb/+/refs/heads/android16-release/ranging/framework/java/android/ranging/RangingMeasurement.java)。メーカー実機での動作保証とは区別する。
