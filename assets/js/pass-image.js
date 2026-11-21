// Render a complete pass (art + details + QR) into a PNG that can be shared as an actual image.
import { qrSvg, artUrl, passUrl } from "./core.js";

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text || "").split(/\s+/);
  let line = "", lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines++;
      line = word;
      if (lines === maxLines - 1) break;
    } else line = test;
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
}

/**
 * @param {{name:string, event:{name:string,club?:string,starts_at:string,venue?:string,art?:number}, checked_in_at?:string, gate?:string}} pass
 * @param {string} token
 * @returns {Promise<Blob>}
 */
export async function passImageBlob(pass, token) {
  await document.fonts?.ready;
  const W = 900, H = 1560;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // paper + printed frame
  ctx.fillStyle = "#12121C";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#FF4FB8";
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, W - 28, H - 28);

  // art strip
  try {
    const art = await loadImage(artUrl(pass.event.art || 0));
    const box = (W - 48) / 340;
    const ar = art.width / art.height;
    let sw, sh, sx = 0, sy = 0;
    if (ar > box) { sh = art.height; sw = sh * box; sx = (art.width - sw) / 2; }
    else { sw = art.width; sh = sw / box; sy = (art.height - sh) / 2; }
    ctx.drawImage(art, sx, sy, sw, sh, 24, 24, W - 48, 340);
    const grad = ctx.createLinearGradient(0, 24, 0, 364);
    grad.addColorStop(0, "rgba(18,18,28,.15)");
    grad.addColorStop(1, "rgba(18,18,28,.8)");
    ctx.fillStyle = grad;
    ctx.fillRect(24, 24, W - 48, 340);
  } catch { /* art is optional */ }

  const ev = pass.event || {};
  ctx.textBaseline = "top";

  ctx.fillStyle = "#AFC0FF";
  ctx.font = "600 32px Oswald, sans-serif";
  wrapText(ctx, (ev.club || "").toUpperCase(), 56, 410, W - 112, 38, 1);

  ctx.fillStyle = "#AFC0FF";
  ctx.font = "700 78px Oswald, sans-serif";
  wrapText(ctx, pass.name || "", 56, 470, W - 112, 82, 2);

  ctx.fillStyle = "#FF4FB8";
  ctx.font = "700 86px Oswald, sans-serif";
  let eventY = pass.name && pass.name.length > 18 ? 670 : 610;
  ctx.fillStyle = "#FF4FB8";
  wrapText(ctx, (ev.name || "").toUpperCase(), 56, eventY, W - 112, 90, 3);
  eventY += 90 * 2;

  ctx.fillStyle = "#AFC0FF";
  ctx.font = "500 38px Oswald, sans-serif";
  ctx.fillText(String(ev.starts_at ? new Date(ev.starts_at).toDateString() : ""), 56, eventY + 10);
  if (ev.venue) ctx.fillText(ev.venue, 56, eventY + 58);

  // QR panel
  const svg = qrSvg(passUrl(token), { fg: "#12121C", margin: 2 });
  const qrSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const qr = await loadImage(qrSrc);
  const size = 430, qx = (W - size) / 2, qy = 1010;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(qx - 22, qy - 22, size + 44, size + 44);
  ctx.drawImage(qr, qx, qy, size, size);

  ctx.fillStyle = pass.checked_in_at ? "#FF7A8F" : "#FF4FB8";
  ctx.font = "600 34px Oswald, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(pass.checked_in_at ? "ALREADY USED" : "SHOW THIS AT THE GATE", W / 2, 1500);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not create pass image")), "image/png");
  });
}

/** Copy the PNG as an image to the clipboard so it can be pasted into Gmail (Chrome/Edge). */
export async function copyImageToClipboard(blob) {
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch { return false; }
}

/** Open Gmail with a prefilled message (links cannot carry attachments). */
export function gmailCompose(to, subject, body) {
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Uses the device share sheet when it accepts files (mobile), otherwise downloads the PNG.
 */
export async function shareOrDownload(blob, filename, text) {
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "GatePass", text });
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "downloaded";
}
