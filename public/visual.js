const paths = {
  menu: "M3 7h18 M3 12h18 M3 17h18",
  house: "M3 10 12 3l9 7v10h-6v-6H9v6H3z",
  folder: "M3 6h6l2 3h10v11H3z",
  clip: "m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2 M6 15l10-10",
  brand: "M12 2 22 8 12 14 2 8Z M2 12l10 6 10-6 M2 16l10 6 10-6",
  home: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  jobs: "M3 7h18v13H3z M8 7V4h8v3 M3 12q9 5 18 0 M10 13h4",
  people: "M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2 M9 10a3 3 0 1 0 .01 0 M17 14a4 4 0 0 1 4 4v2 M16 7a3 3 0 0 1 0 6",
  skills: "M4 5l8-2 8 2v14l-8 2-8-2z M12 4v16 M6 8l4 1 M14 9l4-1",
  calendar: "M3 5h18v15H3z M3 10h18 M7 3v4 M17 3v4",
  spark: "m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z",
  arrow: "M4 12h15 M13 5l7 7-7 7",
  chev: "m9 5 7 7-7 7",
  clock: "M12 3a9 9 0 1 0 .01 0 M12 7v5l3 2",
  file: "M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 16h6",
  msg: "M3 4h18v13H9l-5 4v-4H3z M7 9h10 M7 12h6",
  layers: "m12 3 10 5-10 5L2 8z M3 12l9 5 9-5 M3 16l9 5 9-5",
  chart: "M3 20h18 M6 17v-5 M12 17V6 M18 17V9",
  back: "M20 12H4 M10 5l-7 7 7 7",
  x: "m6 6 12 12 M18 6 6 18",
  book: "M3 4q5-2 9 2 4-4 9-2v14q-5-2-9 2-4-4-9-2z M12 6v14",
  check: "m4 12 5 5L20 6",
  send: "M4 12 20 4l-6 16-3-7z M11 13l9-9",
  pin: "M6 3h12v18l-6-4-6 4z",
};
export function icon(name, cls = "") {
  return (
    '<svg class="icon ' +
    cls +
    '" aria-hidden="true" viewBox="0 0 24 24"><path d="' +
    paths[name] +
    '"/></svg>'
  );
}
export function drawRibbon(c) {
  const rect = c.getBoundingClientRect(),
    w = rect.width,
    h = rect.height,
    dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  const scale = Math.min(w / 360, h / 220),
    cx = w * 0.56,
    cy = h * 0.48;
  function point(t, v) {
    const u = t + 0.12,
      phi = 2.5 * t + 0.4,
      r = 72 + 12 * Math.cos(3 * t) + v * 24 * Math.cos(phi);
    const x = r * Math.cos(u),
      y = r * Math.sin(u),
      z = 22 * Math.sin(2 * t) + v * 24 * Math.sin(phi);
    return [
      cx + scale * (1.42 * x + 0.42 * y),
      cy + scale * (0.31 * x + 0.66 * y - 0.76 * z),
      z + y * 0.42,
    ];
  }
  const strips = [];
  for (let i = 0; i < 232; i++) {
    const a = (i * Math.PI * 2) / 232,
      b = ((i + 1) * Math.PI * 2) / 232,
      P = point(a, -1),
      Q = point(a, 1),
      R = point(b, 1),
      S = point(b, -1);
    strips.push({ P, Q, R, S, z: (P[2] + Q[2]) / 2, a });
  }
  strips.sort((a, b) => a.z - b.z);
  g.lineWidth = 0.6 * scale;
  for (const { P, Q, R, S, a, z } of strips) {
    const v = (Math.cos(2 * a - 1) + 1) / 2,
      shine = (z + 64) / 128;
    g.beginPath();
    g.moveTo(P[0], P[1]);
    g.lineTo(Q[0], Q[1]);
    g.lineTo(R[0], R[1]);
    g.lineTo(S[0], S[1]);
    g.closePath();
    g.fillStyle =
      "rgb(" +
      Math.round(35 + 68 * v + 34 * shine) +
      "," +
      Math.round(69 + 82 * v + 27 * shine) +
      "," +
      Math.round(110 + 74 * v + 45 * shine) +
      ")";
    g.fill();
    g.beginPath();
    g.moveTo(P[0], P[1]);
    g.lineTo(Q[0], Q[1]);
    g.strokeStyle = "rgba(204,234,255," + (0.25 + 0.5 * v) + ")";
    g.stroke();
  }
}
