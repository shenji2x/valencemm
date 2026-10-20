// Runs in <head> before the page paints, so there is no flash of the wrong theme.
// Saved choice wins; otherwise follow the device setting.
(function () {
  var theme = null;
  try { theme = localStorage.getItem("valence_theme"); } catch (e) { /* storage blocked */ }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);

  // A colour theme picked in Settings applies only while that customer is signed in.
  try {
    var palette = localStorage.getItem("valence_palette");
    var signedIn = sessionStorage.getItem("valence_token") ||
      (Number(localStorage.getItem("valence_token_until")) > Date.now() && localStorage.getItem("valence_token"));
    if (palette && signedIn) document.documentElement.setAttribute("data-palette", palette);
  } catch (e) { /* storage blocked */ }
})();
