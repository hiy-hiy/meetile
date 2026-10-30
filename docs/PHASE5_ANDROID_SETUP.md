# Phase 5-4準備：Androidのローカルビルドと起動

作成：2026年10月30日（日本時間）。対象は既存アプリのAndroidビルド・起動経路の整備。BLE・GATT・Ranging API本体は次の単位で実装する。製品仕様・サーバーの正本・審査・外部公開条件は変更しない。

## 必要な環境

- [README](../README.md#開発環境)のNode 22.23.3・pnpm 10.34.6と、インストール済みの依存。
- Android SDK platform 36、build-tools 36.0.0、platform-tools、NDK／CMakeなどExpo／Gradleが要求するツール。SDK Managerで準備する。
- AndroidビルドにはJDK 17。`JAVA_HOME`で明示する。MacのAPI／Emulator試験には別ターミナルでJDK 21を使う。シェル全体の設定は変更しない。
- 起動確認にはAndroid 12以上の端末。USBデバッグを有効にし、Macを許可する。Macと同じWi-Fiへ接続する。実ユーザーの写真は使わない。

ビルド・起動のターミナルで設定する。パスは導入先に置き換える。

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="<JDK 17のHomeディレクトリ>"
"$JAVA_HOME/bin/java" -version
"$ANDROID_HOME/platform-tools/adb" devices -l
```

`local:android`はSDK 36とJDK 17を検査し、`APP_MODE=local`・`APP_ENV=development`に固定する。子プロセスのGradleは最大2ワーカー・デーモン常駐なしにして、同時ビルドによる負荷を抑える。設定は[ローカル起動手順](PHASE3_LOCAL_SETUP.md#起動)の`pnpm local:prepare --host <MacのIPv4>`で用意する。合成したdemo登録だけを使い、通常版のFirebase設定を変更しない。

## ネイティブビルドのみ

```sh
pnpm local:android --build-only
```

Androidプロジェクトをprebuildで再生成し、ARM64向けの`:app:assembleDebug`を実行する。端末・Metroは不要で、インストール・起動は行わない。APKはGit対象外の`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。JavaScriptはDebug版ではMetroから取得するため、この成功だけを画面表示や実通信の確認とは扱わない。初回のGradle依存・SDK部品の取得には時間がかかる。ネイティブ出力を複製する工程があるため、十分なディスク空き容量も必要。

生成済みの`android/`は再生成されるため、通常版のネイティブ作業を同時に行わない。修正は生成フォルダーに直接残さず、app config・config plugin・ローカルモジュールへ保存する。

## 端末へインストールして起動

別ターミナルでJDK 21を使って`pnpm local:server`を起動する。ビルド側のターミナルで、次を実行する。

```sh
pnpm local:android --device <Androidの端末名>
```

Expo CLIの`--device`は端末名を指定する。物理端末の場合は`adb devices -l`の`model:`以降（例：`Pixel_8`）を使う。先頭のADBシリアル番号とは異なる。同じモデルが複数ある場合は対象の1台だけ接続する。エミュレーターはAVD名を指定する。詳細は[Expoのローカルビルド](https://docs.expo.dev/guides/local-app-development/)を参照。

Debugビルド・ローカル専用アプリ`jp.puzzlesns.app.local`のインストール・Metro（8082）・起動を実行する。既存のローカル版へは更新インストールし、検証データは初期化しない。起動後は「Macに接続して準備する」から接続を試す。年齢区分・内部検証の開始確認・撮影を行う場合は人工素材だけを使う。

現在のローカル版の既定は開発用の疑似近接。5-4aで[Android BLE・共通GATT](PHASE5_ANDROID.md)を追加したため、実通信を使う場合は`PROXIMITY_MODE=native`を付けてビルドし、同じ設定でMetroも再起動する。相互通信・距離精度は未確認で、起動や疑似近接の成功をBLE／UWBの合格とは扱わない。

既存のiPhoneコマンド`pnpm local:mobile --device <iPhoneのIdentifier>`は維持する。JSだけの更新では両OSともローカル手順のMetro起動コマンドを使える。MacのIPv4が変わったらprepareとMetroを再実行する。接続できない場合は同一Wi-Fi・ファイアウォール・host・APIとMetroの起動状態を確認する。クラウドへ代替接続しない。

## 確認結果

- 整形・Lint・型検査：成功。
- `pnpm test`：共通・サーバー110件、モバイル155件、Nodeスクリプト9件（新規4件）の計274件が成功。既存iPhone用コマンド、AndroidのDebug指定、ビルドのみの経路、余分な引数・Release指定・不正な環境の拒否を確認。
- `pnpm test:emulators`：12スイート115件が成功。
- ARM64のDebugネイティブビルド：成功。SDK 36・JDK 17を使用。初回の再生成後は容量不足で失敗し、同じビルド出力の再試行はキャッシュロックで失敗した。今回起動したGradleプロセスを終了し、別プロセス・最大2ワーカーで再試行して成功。起動スクリプトにも最大2ワーカー・デーモン常駐なしを反映した。初回取得やネイティブ出力用の空き容量は引き続き必要。
- 最終版の`pnpm local:android --build-only`：prebuildによる再生成からAPK生成まで成功（1分43秒）。インストール・Metro起動は実行しない。
- `pnpm local:android --device <端末名>`：Android 13（API 33）のOPPO PDRM00へ更新インストール・起動が成功。既存のローカル用Metro（8082）を再利用した。画面の「Macに接続して準備する」を実行し、「Macと接続できました。」と内部検証の年齢・開始確認画面を確認。年齢・開始確認は選択せず、撮影・投稿は行っていない。
- ローカル画面のiPhone固定の説明2箇所を「端末」へ修正。アプリ再起動後の実機表示も確認。年齢・開始確認・審査・認可の処理は維持した。

上記の画面確認はADBのUI階層と起動結果による確認で、本人による見た目・操作の確認とは区別する。Android 12・14〜16以上、エミュレーターへのインストール、撮影・権限・再インストール・安全機能、BLE／UWBは未確認。通常版・クラウド・署名配布・外部公開は今回の対象外。

Gitは初回コミット前のため、変更対象のソースをGit対象外の`.tools/android-launch-baseline/`へ保存し、編集前との差分と新規ファイルを確認した。認証ファイルや保存済み検証データの初期化、クラウド設定の変更は行っていない。

## 次に残すこと

通信方式と実装順は[Android詳細設計](PHASE5_ANDROID_DESIGN.md)に記録した。5-4aは[ローカル実装済み](PHASE5_ANDROID.md)。5-4b（Android 16のOOB・UWB）も[ローカル実装済み](PHASE5_ANDROID_UWB.md)。次は5-5の実機試験準備を行う。

- AndroidのBLE・GATT相互通信と、権限・前面離脱時の停止を各OS・機種で確認する。
- Ranging API（Android 16以上）の役割選択・GATT OOB交換・UWB能力確認・BLEへの復帰を対応実機2台で確認する。
- 実機測定前のG-PROX合格基準の確定、各OS・UWB有無・混在・3台以上・遮蔽・混雑での試験。
- iOSの未実施の実通信、安全運用・法務・実クラウドを含む外部公開ゲート。
