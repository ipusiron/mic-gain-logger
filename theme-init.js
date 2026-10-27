// 最初の描画の前にテーマを決める。index.html の <head> で、style.css のあとに同期読み込みする。
//
// style.css の既定はダークで、ライトは light クラスで切り替える。保存値（localStorage の theme）が
// dark のときだけダークにし、それ以外（保存なし・light・想定外の値・読めない環境）はライトにする。
// OS の配色設定は見ない。<head> の時点では <body> が無いので、light は <html> に付ける。
(function () {
  'use strict';
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { saved = null; }
  if (saved !== 'dark') document.documentElement.classList.add('light');
})();
