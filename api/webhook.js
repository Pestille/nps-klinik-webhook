// Webhook NPS da Klinik Odontologia (WhatsApp Cloud API) — arquivo unico.
// GET  ?hub.mode=subscribe...      -> verificacao do webhook (Meta).
// GET  ?key=ADMIN_KEY               -> pagina de resultados (NPS, notas, motivos).
// POST                              -> recebe respostas, ramifica e registra.
//
// Nota 9-10 -> agradece + link de avaliacao no Google.
// Nota 0-8  -> pede o motivo; o motivo seguinte fica registrado.
// Estado/resultados no Vercel KV (Redis REST). Nao loga token nem chave.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "klinik_nps";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const REVIEW_URL = process.env.GOOGLE_REVIEW_URL || "https://g.page/r/CZp0cH6B85kSEBM/review";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const MSG_PROMOTOR =
  "Ficamos felizes pelo seu feedback! Agora, nos ajudaria muito a sua avaliacao no Google (leva menos de 1 minuto): " +
  REVIEW_URL;
const MSG_DETRATOR =
  "Muito obrigado pelo seu feedback! Agora, nos ajude a melhorar: pode nos dizer o motivo da sua nota? Vamos ler com atencao.";
const MSG_AGRADECE_MOTIVO = "Recebemos o seu retorno. Muito obrigado por nos ajudar a melhorar!";

const DIAS90 = 60 * 60 * 24 * 90;
const HORAS48 = 60 * 60 * 48;

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  return (await r.json()).result;
}

async function enviarTexto(to, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body } }),
  });
  if (!resp.ok) console.error("Falha ao enviar:", resp.status, (await resp.text()).slice(0, 300));
}

function parseNota(texto) {
  if (!texto) return null;
  const t = texto.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n >= 0 && n <= 10 ? n : null;
}

async function registra(phone, nome, nota, motivo) {
  const reg = { phone, nome: nome || "", nota, motivo: motivo || "", ts: new Date().toISOString() };
  await kv(["SET", `nps:r:${phone}`, JSON.stringify(reg)]);
  await kv(["SADD", "nps:index", phone]);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export default async function handler(req, res) {
  const q = req.query || {};

  if (req.method === "GET") {
    // 1) verificacao do webhook
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === VERIFY_TOKEN) {
      return res.status(200).send(q["hub.challenge"]);
    }
    // 2) pagina de resultados
    if (ADMIN_KEY && q.key === ADMIN_KEY) return resultados(req, res);
    return res.status(403).send("forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("method not allowed");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const nome = value.contacts && value.contacts[0] && value.contacts[0].profile ? value.contacts[0].profile.name : "";
        for (const msg of value.messages || []) {
          if (msg.type !== "text") continue;
          await processar(msg.from, (msg.text && msg.text.body) || "", nome);
        }
      }
    }
  } catch (e) {
    console.error("Erro webhook:", e && e.message);
  }
  return res.status(200).send("EVENT_RECEIVED");
}

async function processar(from, texto, nome) {
  const nota = parseNota(texto);

  const aguardando = await kv(["GET", `nps:await:${from}`]);
  if (aguardando && nota === null) {
    await registra(from, nome, parseInt(aguardando, 10), texto.trim());
    await kv(["DEL", `nps:await:${from}`]);
    await kv(["SET", `nps:done:${from}`, "1", "EX", String(DIAS90)]);
    await enviarTexto(from, MSG_AGRADECE_MOTIVO);
    return;
  }

  if (nota === null) return;
  if (await kv(["GET", `nps:done:${from}`])) return;

  if (nota >= 9) {
    await registra(from, nome, nota, "(promotor)");
    await kv(["SET", `nps:done:${from}`, "1", "EX", String(DIAS90)]);
    await enviarTexto(from, MSG_PROMOTOR);
  } else {
    await kv(["SET", `nps:await:${from}`, String(nota), "EX", String(HORAS48)]);
    await registra(from, nome, nota, "(aguardando motivo)");
    await enviarTexto(from, MSG_DETRATOR);
  }
}

async function resultados(req, res) {
  const phones = (await kv(["SMEMBERS", "nps:index"])) || [];
  const regs = [];
  for (const p of phones) {
    const raw = await kv(["GET", `nps:r:${p}`]);
    if (raw) { try { regs.push(JSON.parse(raw)); } catch (e) {} }
  }
  regs.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  if ((req.query || {}).format === "csv") {
    const linhas = [["data", "telefone", "nome", "nota", "motivo"]].concat(
      regs.map((r) => [r.ts, r.phone, r.nome, r.nota, (r.motivo || "").replace(/[\r\n;]+/g, " ")])
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.status(200).send(linhas.map((l) => l.join(";")).join("\n"));
  }

  const validos = regs.filter((r) => typeof r.nota === "number");
  const n = validos.length;
  const prom = validos.filter((r) => r.nota >= 9).length;
  const det = validos.filter((r) => r.nota <= 6).length;
  const nps = n ? Math.round(((prom - det) / n) * 100) : 0;
  const rows = regs.map((r) => `<tr><td>${esc(r.ts.replace("T", " ").slice(0, 16))}</td><td style="text-align:center;font-weight:600">${esc(r.nota)}</td><td>${esc(r.motivo)}</td><td>${esc(r.phone)}</td><td>${esc(r.nome)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NPS Klinik</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f6f7f9;color:#1b1f23}.wrap{max-width:900px;margin:0 auto;padding:24px 16px}h1{font-size:20px}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;flex:1;min-width:120px}.card .v{font-size:28px;font-weight:700}.card .l{font-size:13px;color:#6b7280}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid #eef0f2;font-size:14px;text-align:left;vertical-align:top}th{background:#fafbfc;color:#6b7280}tr:last-child td{border-bottom:none}.muted{color:#6b7280;font-size:13px;margin-top:14px}a.btn{display:inline-block;margin-top:10px;font-size:13px;color:#2563eb}</style></head>
<body><div class="wrap"><h1>Pesquisa NPS — Klinik Odontologia</h1>
<div class="cards"><div class="card"><div class="v">${nps}</div><div class="l">NPS</div></div><div class="card"><div class="v">${n}</div><div class="l">Respostas</div></div><div class="card"><div class="v">${prom}</div><div class="l">Promotores (9-10)</div></div><div class="card"><div class="v">${det}</div><div class="l">Detratores (0-6)</div></div></div>
<table><thead><tr><th>Data</th><th>Nota</th><th>Motivo</th><th>Telefone</th><th>Nome</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">Ainda sem respostas.</td></tr>'}</tbody></table>
<a class="btn" href="?key=${esc((req.query || {}).key || "")}&format=csv">Baixar CSV</a>
<p class="muted">NPS = % promotores (9-10) menos % detratores (0-6). Neutros (7-8) nao entram na conta.</p></div></body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
}
