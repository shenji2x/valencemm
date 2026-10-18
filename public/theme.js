// Runs in <head> before the page paints, so there is no flash of the wrong theme.
// Saved choice wins; otherwise follow the device setting.
(function () {
  var theme = null;
  try { theme = localStorage.getItem("valence_theme"); } catch (e) { /* storage blocked */ }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
