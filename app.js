"use strict";

const $ = (id) => document.getElementById(id);
let me = { loggedIn: false, user: null, account: null };
let generatedCode = null;

function mostrarAviso(message, type = "ok") {
  const el = $("status-banner");
  el.textContent = message;
  el.classList.remove("hidden");
  el.style.background = type === "error" ? "#351715" : "#15351f";
  el.style.borderColor = type === "error" ? "#87433e" : "#2c6740";
  el.style.color = type === "error" ? "#ffd0c9" : "#b8ecc2";
}
function ocultarAviso() { $("status-banner").classList.add("hidden"); }
function irParaTab(tab) {
  const selected = tab === "verificar" ? "verificar" : "cadastro";
  document.querySelectorAll("[data-tab]").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === selected));
  $("cadastro-view").classList.toggle("hidden", selected !== "cadastro");
  $("verificar-view").classList.toggle("hidden", selected !== "verificar");
  $("panel-title").textContent = selected === "verificar" ? "Verificar no Discord" : "Cadastro da conta Roblox";
  const url = selected === "verificar" ? "/verificar" : "/cadastro";
  if (location.pathname !== url) history.replaceState({}, "", url);
  ocultarAviso();
}
async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data.error || data.erro || `Erro HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function mostrarConta() {
  const logged = me.loggedIn;
  $("login-required").classList.toggle("hidden", logged);
  $("dashboard").classList.toggle("hidden", !logged);
  $("login-button").classList.toggle("hidden", logged);
  $("logout-button").classList.toggle("hidden", !logged);
  $("account-label").textContent = logged ? `Conectado: ${me.user.globalName || me.user.username}` : "Não conectado";
  if (!logged) return;

  const account = me.account;
  if (account?.linked) {
    $("account-summary").classList.remove("hidden");
    $("summary-avatar").textContent = "RBX";
    $("summary-roblox").textContent = account.robloxUsername || "Conta Roblox vinculada";
    $("summary-rank").textContent = account.inGroup ? `Patente no grupo: ${account.rankName || "Não identificada"}` : "Não encontrado no grupo EB — será verificado como Civil";
    $("link-state").textContent = "Conta vinculada";
    $("link-state").className = "pill pill-good";
    $("verify-unlinked").classList.add("hidden");
    $("run-verify").disabled = false;
  } else {
    $("account-summary").classList.add("hidden");
    $("link-state").textContent = "Ainda não vinculado";
    $("link-state").className = "pill pill-neutral";
    $("verify-unlinked").classList.remove("hidden");
    $("run-verify").disabled = true;
  }
}
async function carregar() {
  $("year").textContent = new Date().getFullYear();
  try {
    const config = await request("/api/config", { method: "GET", headers: {} });
    if (config.helpChannelUrl) $("help-link").href = config.helpChannelUrl;
  } catch {}
  const query = new URLSearchParams(location.search);
  if (query.get("erro") === "oauth_state") mostrarAviso("A sessão de login expirou ou não pôde ser confirmada. Tente entrar novamente.", "error");
  if (query.get("erro") === "oauth") mostrarAviso("Não foi possível fazer login no Discord. Confira a configuração OAuth2 do site.", "error");
  try {
    me = await request("/api/me", { method: "GET", headers: {} });
    mostrarConta();
  } catch (error) {
    mostrarAviso(error.message, "error");
  }
  irParaTab(location.pathname === "/verificar" ? "verificar" : "cadastro");
}

$("login-button").addEventListener("click", () => location.href = "/auth/discord");
$("logout-button").addEventListener("click", async () => {
  try { await request("/auth/logout", { method: "POST", body: "{}" }); location.href = "/"; }
  catch (error) { mostrarAviso(error.message, "error"); }
});
document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => irParaTab(button.dataset.tab)));

$("generate-code").addEventListener("click", async () => {
  const button = $("generate-code");
  button.disabled = true;
  button.textContent = "Gerando...";
  try {
    const data = await request("/api/register/start", { method: "POST", body: "{}" });
    generatedCode = data.code;
    $("verification-code").textContent = data.code;
    $("code-box").classList.remove("hidden");
    $("confirm-form").classList.remove("hidden");
    mostrarAviso("Código gerado. Cole exatamente esse código na descrição pública do seu perfil Roblox.");
  } catch (error) {
    mostrarAviso(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Gerar novo código";
  }
});

$("copy-code").addEventListener("click", async () => {
  const code = generatedCode || $("verification-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    $("copy-code").textContent = "Copiado!";
    setTimeout(() => $("copy-code").textContent = "Copiar código", 1800);
  } catch {
    mostrarAviso("Não foi possível copiar automaticamente. Selecione e copie o código exibido.", "error");
  }
});

$("confirm-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  const username = $("roblox-username").value.trim();
  if (!username) return;
  button.disabled = true;
  button.textContent = "Conferindo bio e patente...";
  try {
    const data = await request("/api/register/confirm", { method: "POST", body: JSON.stringify({ username }) });
    mostrarAviso(data.message || `Conta ${data.robloxUsername} vinculada com sucesso.`);
    me = await request("/api/me", { method: "GET", headers: {} });
    mostrarConta();
  } catch (error) {
    mostrarAviso(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Confirmar conta Roblox";
  }
});

$("run-verify").addEventListener("click", async () => {
  const button = $("run-verify");
  const result = $("verify-result");
  button.disabled = true;
  button.textContent = "Consultando grupo e atualizando Discord...";
  result.classList.add("hidden");
  result.classList.remove("error");
  try {
    const data = await request("/api/verify", { method: "POST", body: "{}" });
    result.classList.remove("hidden");
    const lines = [
      data.inGroup ? "Verificação concluída" : "Verificação Civil concluída",
      `Apelido: ${data.nickname || "atualizado"}`,
      data.rankName ? `Patente Roblox: ${data.rankName}` : "Patente: Civil (não está no grupo EB)",
      `Cargos aplicados: ${(data.addedRoles || []).join(", ") || (data.inGroup ? "conferir no Discord" : "Verificado")}`
    ];
    const divisoesComCargo = (data.divisions || []).filter(d => d.inGroup && d.cargoTipo);
    if (divisoesComCargo.length) {
      lines.push(`Divisões sincronizadas: ${divisoesComCargo.map(d => `${d.name} (${d.cargoTipo === "aplicador" ? "Aplicador" : "Membro"})`).join(", ")}`);
    }
    const warningsDivisao = data.divisionWarnings || [];
    if (warningsDivisao.length) lines.push(`Avisos das divisões: ${warningsDivisao.join(" | ")}`);
    const title = document.createElement("strong");
    title.textContent = lines.shift();
    const body = document.createElement("div");
    body.textContent = lines.join("\n");
    body.style.whiteSpace = "pre-line";
    result.replaceChildren(title, body);
    mostrarAviso(data.message || "Sua verificação foi concluída.");
    me = await request("/api/me", { method: "GET", headers: {} });
    mostrarConta();
  } catch (error) {
    result.classList.remove("hidden");
    result.classList.add("error");
    const title = document.createElement("strong");
    title.textContent = "Não foi possível concluir";
    const body = document.createElement("div");
    body.textContent = error.message;
    result.replaceChildren(title, body);
    mostrarAviso(error.message, "error");
  } finally {
    button.disabled = !me.loggedIn || !me.account?.linked;
    button.textContent = "Verificar e atualizar meus cargos";
  }
});

carregar();
