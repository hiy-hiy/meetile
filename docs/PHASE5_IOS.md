# Phase 5-3：iOS近接通信

作成：2026年10月30日（日本時間）。対象は[設計案](PHASE5_DESIGN.md)の単位5-3。

実装は`apps/mobile/modules/proximity/ios/`、TypeScriptの接続は`apps/mobile/src/fit/native.ts`と`factory.ts`。製品の成立判定は従来どおりサーバーが行い、距離のしきい値・継続時間・複数候補の判定は`policy.ts`に置く。

## ローカルで実装した内容

- Core Bluetoothの広告と探索を同時に動かす。広告は環境別の固定サービスUUIDだけで、名前・写真・FITトークン・安全IDは載せない。
- GATTの読み取りでサーバー発行の128bitトークンを交換する。探索直後のトークン未取得端末も観測値として通知し、複数候補の判定から除外しない。接続中はRSSIを読み直す。
- Nearby Interactionの能力を確認し、GATTで交換した`NIDiscoveryToken`でiPhone同士の測距を始める。アーカイブは短期FITトークンに結び付け、サイズ・バージョンを制限し、クラスを限定して復号する。カメラ補助、方向情報、位置情報は利用しない。
- NI非対応・拒否・中断・失効・開始後5秒で測距できない場合はBLEへ戻る。測距中の値は1秒以内の観測だけを利用する。NIは1回の探索で1相手と測距する。複数候補を検知した状態ではTypeScript側がFIT報告を止める。
- アプリが非アクティブになると、JSの処理を待たずに広告・探索・接続・測距を止め、メモリー上のトークンを破棄する。復帰だけでは再開しない。「もう一度試す」で新しい探索を始める。権限ダイアログで中断した場合も再試行が必要になる可能性があるため、実機で確認する。
- 試行ごとのIDで遅いイベントを無視する。Core Bluetoothの端末識別子はJSへ出さず、探索ごとの一時ハンドルを使う。値や相手をファイル・サーバーログへ記録しない。
- 相互検知の報告後、相手が先に電波を止めた場合も、同じトークンの報告を再照会して成立結果を受け取る。本人限定の進捗通知も再照会の契機にする。古い進捗通知だけでは相手を表示しない。複数候補を検知した間は再照会を止める。
- トークンを探索中30秒で更新し、観測窓を消去する。JSが止まった場合もネイティブは探索開始から45秒で停止し、GATTの読み出しも拒否する。この経過時間は端末内の保守的な停止用であり、実際の期限・日付・資格はサーバーが判定する。
- Bluetooth権限なし・無線オフ・非対応・中断を既存画面へ通知する。権限の説明をInfo.plistへ追加する。バックグラウンドのBluetoothモードは追加しない。

数値は設計案§7の開発用仮値を引き継ぐ。BLEで正確な10cmを保証しない。単体試験・コンパイル成功を実通信や実距離の合格とは扱わない。

## Androidへ引き継ぐGATT形式

| 項目                   | 値・形式                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| developmentサービス    | `BD1E1000-0E40-4CB6-AF31-8B034F29A718`                                                                                                                                      |
| stagingサービス        | `BD1E2000-0E40-4CB6-AF31-8B034F29A718`                                                                                                                                      |
| production予約サービス | `BD1E3000-0E40-4CB6-AF31-8B034F29A718`（本番ビルドの有効化は別ゲート）                                                                                                      |
| localサービス          | `BD1E4000-0E40-4CB6-AF31-8B034F29A718`                                                                                                                                      |
| FITトークン特性        | `BD1E1001-0E40-4CB6-AF31-8B034F29A718`。読み取り専用、16バイトの生データ。APIへはbase64url（paddingなし・22文字）で渡す                                                     |
| NI特性                 | `BD1E1002-0E40-4CB6-AF31-8B034F29A718`。読み取り専用、`0x01 + FITトークン16バイト + NSSecureCodingアーカイブ`。最大4096バイト、オフセット読み取りに対応。非対応時は空データ |

iPhone–Androidは当面BLEで判定する。AndroidはAppleのNIアーカイブを復号しない。Android 16のRanging API用の交換内容は単位5-4で別途定義する。固定UUIDは製品の探索用であり、認証情報ではない。ネイティブ側でもBundle IDから期待するUUIDを照合する。

5-5cで、自分のトークンを読みに来たcentralの既存リンクを使って相手のトークンを読む予備経路を追加した（Androidが先に接続した場合、iPhoneからの接続が成立しないため）。詳細は[5-5cの記録](PHASE5_GATT_LINK.md)。

## 自動検査

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:emulators
# macOS + Xcodeのみ。SDK型検査とホスト上のGATT形式試験。
pnpm test:proximity:ios
```

`test:proximity:ios`はSwiftの通信実装をiOS 16.4ターゲットで型検査し、トークン形式・NIデータの結び付け・長いGATT読み取り・不正なオフセットをホストで検証する。Expoブリッジのコンパイル・リンクは、別途Development Buildの再生成とXcodeビルドで確認する。

## 2台を用意できたときの実機手順（未実施）

ユーザーは2026年10月30日、今は2台を用意できないと回答した。実通信・距離精度は未確認として残す。まず設計案§7のG-PROX合格基準と機種・OSを決め、人工の写真だけで試す。

1. [ローカル起動手順](PHASE3_LOCAL_SETUP.md)でMacのローカルサーバーを起動し、2台を同じWi-Fiへ接続する。
2. 両端末のDevelopment Buildを次のコマンドで再生成・インストールする。疑似近接と区別するため、必ず`PROXIMITY_MODE=native`を付ける。通常のクラウド版は既定でネイティブを選ぶ。設定変更後はMetroを再起動する。

   ```sh
   PROXIMITY_MODE=native pnpm local:mobile --device <iPhoneのIdentifier>
   ```

3. 両端末で人工のピースを作り、FITを開く。BluetoothとNearby Interactionの許可を確認する。権限ダイアログ後に探索が止まった場合は再試行する。
4. 約10cmで双方が相手本人の1枚だけを確認でき、双方確認で成功または形状による不成立になることを確認する。形状による不成立も正常である。
5. 片方だけ確認、相手の離脱、画面ロック、ホームへ移動、Bluetoothオフ、Bluetooth拒否、NI拒否・非対応、探索30秒超・日付境界、通信切断を確認する。離脱後の広告・GATT読み出し・測距が続かないことも確認する。
6. 設計案§7の距離・向き・遮蔽・混雑条件を測る。3台以上の試験には3台目が必要。UWBの距離が遠い場合にBLEが近いだけで成立しないことを確認する。初期値を合格値として扱わない。

実機測定結果、使用ビルド、機種・OS、確認者、未達条件を追記する。Android・混在は5-4以降、機種補正・正式な合格判定は5-5で行う。

## 参照した公式資料

- [Core BluetoothのPeripheral実装・オフセット読み取り](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/PerformingCommonPeripheralRoleTasks/PerformingCommonPeripheralRoleTasks.html)
- [Nearby Interactionの開始・権限・ライフサイクル](https://developer.apple.com/documentation/nearbyinteraction/initiating-and-maintaining-a-session)
- [Expo Modulesの登録](https://docs.expo.dev/modules/module-config/)・[キューの指定](https://docs.expo.dev/modules/module-api/)

## 2026年10月30日の検査結果

- 整形・Lint・TypeScript型検査：成功。
- `pnpm test`：共通・サーバー11スイート110件、モバイル20スイート155件、Nodeスクリプト5件が成功。ネイティブ接続のイベント検証・遅い通知の破棄・停止・入力拒否、選択処理、更新・再試行・相手の広告終了後の成立受信を含む。
- `pnpm test:emulators`：12スイート115件が成功。既存のサーバー・Rulesの回帰を確認。
- `pnpm test:proximity:ios`：iOS 16.4向けSDK型検査とホスト上のGATT形式試験が成功。
- `pnpm check:local-boundaries`：通常のiOS／AndroidバンドルとFunctionsにローカル専用コードが入らないことを確認。
- Xcode 27／iPhoneOS 27 SDKで、iOS実機向けarm64の署名なしDebugネイティブビルドが成功（`CODE_SIGNING_ALLOWED=NO`・`SKIP_BUNDLING=1`）。Expoブリッジを含むコンパイルとリンクを確認。JavaScriptは上記のバンドル検査で別途確認し、インストール・起動・実通信は未実施。
- ExpoのiOS再生成とCocoaPodsのローカルモジュール登録が成功。生成されたInfo.plistのBluetooth・Nearby Interaction説明と、ExpoModulesProviderへの`ProximityModule`登録も確認。

編集前のローカルコピーとの差分と新規ファイルを確認し、盤面の統合ルール・サーバー認可・公開範囲・安全IDの用途を変更していないことを確認した。2台の実通信と距離試験は未実施。実クラウド・署名・配布はこの検査に含まない。

**5-5eでの変更**：トークン特性値の末尾にOS区分1バイト（iOSは1）を足し、読み取った相手の区分と端末の機種ID（`utsname.machine`）をRSSI補正の選択だけに使う。16バイトの値は区分不明として受ける。[5-5eの記録](PHASE5_GPROX_CALIBRATION.md)。
