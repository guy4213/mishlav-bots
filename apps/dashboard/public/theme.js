// The theme before the first paint (no flash): light / dark from localStorage, else the system's.
try {
  var t = localStorage.getItem("mishlav_theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
