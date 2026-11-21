// Direct Google Sheets writes from the organiser's browser. No server, no Apps Script.
let tokenClient = null, accessToken = null, tokenExpiry = 0;

function gis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google.accounts.oauth2);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => window.google?.accounts?.oauth2 ? resolve(window.google.accounts.oauth2) : reject(new Error("Google Identity Services failed to load"));
    s.onerror = () => reject(new Error("Could not load Google Identity Services"));
    document.head.append(s);
  });
}

export async function connectSheet(clientId) {
  if (!clientId) throw new Error("Add your Google OAuth client ID to firebase-config.js first.");
  const g = await gis();
  tokenClient = g.initTokenClient({
    client_id: clientId,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    callback: (r) => {
      if (r.error) throw new Error(r.error);
      accessToken = r.access_token;
      tokenExpiry = Date.now() + (r.expires_in || 3600) * 1000;
    },
  });
  return new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error));
      accessToken = r.access_token;
      tokenExpiry = Date.now() + (r.expires_in || 3600) * 1000;
      resolve(true);
    };
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

export const hasSheetToken = () => !!accessToken;

async function token() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  if (!tokenClient) throw new Error("Connect the Google Sheet first.");
  await new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error));
      accessToken = r.access_token;
      tokenExpiry = Date.now() + (r.expires_in || 3600) * 1000;
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: "none" });
  });
  return accessToken;
}

export function sheetIdFromUrl(input = "") {
  const m = String(input).match(/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : String(input).trim() || "";
}

export async function appendRows(sheetId, range, rows) {
  const t = await token();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range || "Registrations")}:append?valueInputOption=USER_ENTERED`,
    { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) }
  );
  if (!res.ok) {
    let msg = `Google Sheets returned ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
