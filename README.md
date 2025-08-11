# Mic Gain Logger - マイク音量ロガー

![GitHub Repo stars](https://img.shields.io/github/stars/ipusiron/mic-gain-logger?style=social)
![GitHub forks](https://img.shields.io/github/forks/ipusiron/mic-gain-logger?style=social)
![GitHub last commit](https://img.shields.io/github/last-commit/ipusiron/mic-gain-logger)
![GitHub license](https://img.shields.io/github/license/ipusiron/mic-gain-logger)
[![GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-blue?logo=github)](https://ipusiron.github.io/mic-gain-logger/)

**Day041 - 生成AIで作るセキュリティツール100**

**Mic Gain Logger** は、調査員・探偵などが現場で利用することを想定した、Webブラウザベースのマイク音量モニターツールです。録音機能はあえて搭載せず、音の「存在」や「強さ」をリアルタイムで可視化・記録することに特化しています。

---

## 🌐 デモページ

👉 [https://ipusiron.github.io/mic-gain-logger/](https://ipusiron.github.io/mic-gain-logger/)

---

## 📸 スクリーンショット

> ![ダミー](assets/screenshot.png)  
>
> *ダミー（iPhoneのSafariブラウザーで利用しているシーン）*

---

## 🎯 特徴
- **リアルタイム音量可視化**  
  Web Audio APIを用いて、マイク入力の音量（RMSまたはdB）を即時にグラフ化。
- **波形統計表示**  
  平均・最大・変動幅などの簡易統計をリアルタイムに更新。
- **録音なし**  
  音声そのものは保存せず、音量データのみを扱うことで軽量かつプライバシー配慮。
- **CSVログ出力**  
  タイムスタンプ付き音量データをCSVファイルとしてエクスポート可能。
- **即起動・事前準備不要**  
  ページを開き、マイクアクセスを許可するだけで動作開始。
- **シンプルかつインパクトのあるUI**  
  大型数値表示・カラーゲージ・リアルタイムグラフなど、誰が見ても直感的に理解できるデザイン。

---

## 📂 ディレクトリー構成

```
mic-gain-logger/
├── index.html # GitHub Pagesのトップページ
├── style.css # デザイン
├── script.js # ロジック（音量取得・可視化・CSV出力）
├── assets/ # README.mdに掲載するスクリーンショット画像
│ ├── screenshot1.png
│ └── screenshot2.png
├── README.md
└── .nojekyll # Jekyll無効化
```

---

## 💡 将来的な追加アイデア
- **音量閾値トリガー**  
  設定したdB値を超えるとグラフにマーカーや警告表示を付与。
- **長時間稼働対応**  
  メモリ消費を抑えながら数時間〜一晩のログ記録が可能な設計。
- **ステルスモード**  
  UIを暗くして画面を目立たなくするモード。
- **キャリブレーション機能**  
  実測dB SPLに近づけるための補正値設定。

## 🌐 技術スタック
- HTML / CSS / JavaScript（VanillaJS）
- Web Audio API（音声入力・分析）
- Canvas または Chart.js（グラフ描画）
- Blob API（CSV出力）

---

## 📄 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) をご覧ください。

---

## 🛠 このツールについて

本ツールは、「生成AIで作るセキュリティツール100」プロジェクトの一環として開発されました。  
このプロジェクトでは、AIの支援を活用しながら、セキュリティに関連するさまざまなツールを100日間にわたり制作・公開していく取り組みを行っています。

プロジェクトの詳細や他のツールについては、以下のページをご覧ください。

🔗 [https://akademeia.info/?page_id=42163](https://akademeia.info/?page_id=42163)
