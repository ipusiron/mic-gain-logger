// 配色の切り替え（自動 → 明るい → 暗い）。選んだ配色はこのブラウザーにだけ残す。
// 本文を描く前に配色を決めるため <head> に置く（あとで切り替えると一瞬ちらつく）
(function () {
  const KEY = 'toneSweepTheme';
  const LABEL = { auto: '配色：自動', light: '配色：明るい', dark: '配色：暗い' };
  const NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
  let mode = 'auto';
  try { mode = localStorage.getItem(KEY) || 'auto'; } catch (e) { mode = 'auto'; }
  if (!LABEL[mode]) mode = 'auto';
  function apply() {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    const b = document.getElementById('themeBtn');
    if (b) b.textContent = LABEL[mode];
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('themeBtn').addEventListener('click', () => {
      mode = NEXT[mode];
      try { localStorage.setItem(KEY, mode); } catch (e) { /* 保存できなくても切り替えは効かせる */ }
      apply();
    });
  });
})();
