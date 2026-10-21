"use strict";

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = String(process.env.BASE_URL || "").replace(/\/+$/, "");
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || (BASE_URL ? `${BASE_URL}/auth/discord/callback` : "");
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const BOT_API_URL = process.env.BOT_API_URL || "";
const VERIFICATION_WEBHOOK_SECRET = process.env.VERIFICATION_WEBHOOK_SECRET || "";
const GUILD_ID = process.env.GUILD_ID || "";
const ROBLOX_GROUP_ID = String(process.env.ROBLOX_GROUP_ID || "13616747");
const CHANNEL_HELP_ID = "1548062752386580560";

// Divisões Roblox e seus cargos correspondentes no Discord.
// As patentes são consultadas na API pública do Roblox; nenhum rank é inventado.
const DIVISOES = [
    { key: "bfe", name: "BFE", groupId: "645168178", cargoMembro: "1548061539615903774", cargoAplicador: "1548061549095161876" },
    { key: "bpe", name: "BPE", groupId: "226820203", cargoMembro: "1548061558922289183", cargoAplicador: "1548061569852637184" },
    { key: "bac", name: "BAC", groupId: "155494210", cargoMembro: "1548061516836896828", cargoAplicador: "1548061531898519673" },
    { key: "cie", name: "CIE", groupId: "1016070492", cargoMembro: "1548061598474838036", cargoAplicador: "1548061606573907998" },
    { key: "cigs", name: "CIGS", groupId: "874033602", cargoMembro: "1548061495676375121", cargoAplicador: "1548061503737954425" },
    { key: "bip", name: "BIP", groupId: "981733822", cargoMembro: "1548061615113371779", cargoAplicador: "1548061630145761322" }
];
const CACHE_ROLES_DIVISAO_MS = 15 * 60 * 1000;
const cacheRolesDivisao = new Map();

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !SESSION_SECRET || !DATABASE_URL) {
    console.error("ERRO: configure DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, SESSION_SECRET e DATABASE_URL.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : (process.env.PGSSLMODE === "require" || DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined)
});

async function prepararBanco() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS eb_accounts (
            discord_id TEXT PRIMARY KEY,
            discord_username TEXT NOT NULL,
            roblox_user_id BIGINT,
            roblox_username TEXT,
            verification_code TEXT,
            code_expires_at TIMESTAMPTZ,
            linked BOOLEAN NOT NULL DEFAULT FALSE,
            in_group BOOLEAN NOT NULL DEFAULT FALSE,
            rank_name TEXT,
            rank_number INTEGER,
            last_synced_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS eb_accounts_roblox_id_idx ON eb_accounts (roblox_user_id)`);
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(session({
    name: "eb.verificacao.sid",
    store: new PgSession({ pool, tableName: "site_sessions", createTableIfMissing: true }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 365 * 24 * 60 * 60 * 1000
    }
}));

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
});

function exigirLogin(req, res, next) {
    if (!req.session.discordUser) {
        return res.status(401).json({ error: "Entre com sua conta Discord para continuar.", loginRequired: true });
    }
    next();
}

function validarOrigem(req, res, next) {
    const origin = req.get("origin");
    if (origin) {
        try {
            const origem = new URL(origin).host;
            const host = req.get("host");
            if (origem !== host) return res.status(403).json({ error: "Origem da requisição não autorizada." });
        } catch {
            return res.status(403).json({ error: "Origem inválida." });
        }
    }
    next();
}

async function apiRoblox(url, options = {}) {
    const resposta = await fetch(url, {
        ...options,
        headers: { "Accept": "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
        signal: AbortSignal.timeout(12000)
    });
    const texto = await resposta.text();
    let dados = {};
    try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = {}; }
    if (!resposta.ok) {
        const error = new Error(`A API do Roblox respondeu HTTP ${resposta.status}.`);
        error.status = resposta.status;
        throw error;
    }
    return dados;
}

async function buscarUsuarioRobloxPorNome(username) {
    const data = await apiRoblox("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
    });
    const usuario = Array.isArray(data.data) ? data.data[0] : null;
    if (!usuario || !usuario.id || !usuario.name) return null;
    return { id: String(usuario.id), name: String(usuario.name), displayName: String(usuario.displayName || usuario.name) };
}

async function buscarPerfilRoblox(userId) {
    return apiRoblox(`https://users.roblox.com/v1/users/${encodeURIComponent(userId)}`);
}

async function buscarGruposRoblox(userId) {
    const dados = await apiRoblox(`https://groups.roblox.com/v2/users/${encodeURIComponent(userId)}/groups/roles`);
    return Array.isArray(dados.data) ? dados.data : [];
}

function buscarPatenteEB(listaGrupos) {
    const registro = listaGrupos.find(item => String(item?.group?.id) === ROBLOX_GROUP_ID);
    if (!registro) return { inGroup: false, rankName: null, rankNumber: null };
    return {
        inGroup: true,
        rankName: String(registro.role?.name || ""),
        rankNumber: Number.isFinite(Number(registro.role?.rank)) ? Number(registro.role.rank) : null
    };
}

function normalizarNomeCargoRoblox(valor = "") {
    return String(valor)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/^\s*\[[^\]]+\]\s*/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

async function buscarCargosGrupoDivisao(groupId) {
    const cache = cacheRolesDivisao.get(String(groupId));
    if (cache && Date.now() - cache.at < CACHE_ROLES_DIVISAO_MS) return cache.roles;
    const dados = await apiRoblox(`https://groups.roblox.com/v1/groups/${encodeURIComponent(groupId)}/roles`);
    const lista = Array.isArray(dados.roles) ? dados.roles : (Array.isArray(dados.data) ? dados.data : []);
    if (!lista.length) throw new Error(`A API do Roblox não retornou as funções do grupo ${groupId}.`);
    const roles = lista.map(role => ({
        id: String(role.id ?? ""),
        name: String(role.name ?? ""),
        rank: Number(role.rank ?? 0)
    }));
    cacheRolesDivisao.set(String(groupId), { at: Date.now(), roles });
    return roles;
}

function classificarFallbackPeloEB(nomePatenteEB) {
    const nome = normalizarNomeCargoRoblox(nomePatenteEB);
    if (["recruta", "rec", "soldado", "sld", "cabo", "cb"].includes(nome)) return "membro";
    // Fallback utilizado somente se o Roblox não expuser um posto "Graduado" na hierarquia da divisão.
    if (/(sargento|sgt|subtenente|cadete|aspirante|tenente|capitao|major|coronel|general|marechal|comandante|elite|criador|administrador|moderador)/.test(nome)) return "aplicador";
    return null;
}

async function buscarDivisoesRoblox(listaGrupos, patenteEB) {
    const resultados = await Promise.all(DIVISOES.map(async divisao => {
        const membership = listaGrupos.find(item => String(item?.group?.id) === divisao.groupId);
        if (!membership) {
            return { key: divisao.key, name: divisao.name, groupId: divisao.groupId, inGroup: false, rankName: null, rankNumber: null, cargoTipo: null };
        }

        const rankName = String(membership.role?.name || "");
        const rankNumber = Number.isFinite(Number(membership.role?.rank)) ? Number(membership.role.rank) : null;
        let cargoTipo = null;
        let aviso = null;
        const rankNormalizado = normalizarNomeCargoRoblox(rankName);

        try {
            const cargos = await buscarCargosGrupoDivisao(divisao.groupId);
            const candidato = cargos.find(role => {
                const nome = normalizarNomeCargoRoblox(role.name);
                return nome.includes("candidato") && nome.includes("praca");
            });
            const graduado = cargos.find(role => {
                const nome = normalizarNomeCargoRoblox(role.name);
                return nome === "graduado" || nome === "graduados" || /^graduado/.test(nome);
            });
            const criador = cargos.find(role => normalizarNomeCargoRoblox(role.name) === "criador") ||
                cargos.find(role => {
                    const nome = normalizarNomeCargoRoblox(role.name);
                    return nome.includes("criador") && !nome.includes("subcriador");
                });

            // Candidato a Praça recebe o cargo normal da divisão.
            if (rankNormalizado.includes("candidato") && rankNormalizado.includes("praca")) {
                cargoTipo = "membro";
            } else if (candidato && rankNumber !== null && rankNumber === candidato.rank) {
                cargoTipo = "membro";
            }

            // Graduado até Criador recebe o cargo de aplicador. Usamos a ordem real das patentes da divisão.
            if (!cargoTipo && graduado && rankNumber !== null && rankNumber >= graduado.rank &&
                (!criador || rankNumber <= criador.rank)) {
                cargoTipo = "aplicador";
            }
            if (!cargoTipo && !graduado && candidato && rankNumber !== null && rankNumber > candidato.rank &&
                (!criador || rankNumber <= criador.rank)) {
                cargoTipo = "aplicador";
            }
            if (!cargoTipo && /(graduado|subcomandante|comandante|criador)/.test(rankNormalizado)) {
                cargoTipo = "aplicador";
            }
            if (!cargoTipo && !graduado && !candidato) {
                cargoTipo = classificarFallbackPeloEB(patenteEB?.rankName);
                if (cargoTipo) aviso = "Classificação feita pela patente do grupo principal porque a hierarquia da divisão não informa os postos Candidato a Praça/Graduado.";
            }
        } catch (error) {
            console.error(`[DIVISÃO ${divisao.name}] Falha ao consultar hierarquia:`, error.message);
            // Não alteramos cargos atuais desta divisão se a classificação não puder ser confirmada.
            aviso = "Não foi possível consultar a hierarquia desta divisão; os cargos atuais dela serão preservados.";
        }

        if (!cargoTipo && !aviso) {
            aviso = `O posto "${rankName || "não identificado"}" não corresponde a Candidato a Praça nem a Graduado–Criador; os cargos desta divisão serão preservados.`;
        }

        return {
            key: divisao.key,
            name: divisao.name,
            groupId: divisao.groupId,
            inGroup: true,
            rankName,
            rankNumber,
            cargoTipo,
            aviso
        };
    }));
    return resultados;
}

async function obterConta(discordId) {
    const result = await pool.query("SELECT * FROM eb_accounts WHERE discord_id = $1", [discordId]);
    return result.rows[0] || null;
}

async function chamarBot(payload) {
    if (!BOT_API_URL || !VERIFICATION_WEBHOOK_SECRET) {
        const error = new Error("A integração com o bot ainda não está configurada. Configure BOT_API_URL e VERIFICATION_WEBHOOK_SECRET no site.");
        error.status = 503;
        throw error;
    }
    const response = await fetch(BOT_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-verification-secret": VERIFICATION_WEBHOOK_SECRET
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { erro: text.slice(0, 300) }; }
    if (!response.ok || data.sucesso === false) {
        const error = new Error(data.erro || data.error || `O bot respondeu HTTP ${response.status}.`);
        error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
        throw error;
    }
    return data;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "eb-verificacao" }));
app.get("/api/config", (_req, res) => res.json({ helpChannelUrl: GUILD_ID ? `https://discord.com/channels/${GUILD_ID}/${CHANNEL_HELP_ID}` : `https://discord.com/channels/@me/${CHANNEL_HELP_ID}` }));

app.get("/auth/discord", (req, res) => {
    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;
    req.session.save(error => {
        if (error) return res.status(500).send("Não foi possível iniciar o login.");
        const url = new URL("https://discord.com/oauth2/authorize");
        url.searchParams.set("client_id", DISCORD_CLIENT_ID);
        url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("scope", "identify");
        url.searchParams.set("state", state);
        res.redirect(url.toString());
    });
});

app.get("/auth/discord/callback", async (req, res) => {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
        return res.redirect("/?erro=oauth_state");
    }
    delete req.session.oauthState;
    try {
        const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: "authorization_code",
                code,
                redirect_uri: DISCORD_REDIRECT_URI
            }),
            signal: AbortSignal.timeout(12000)
        });
        const tokenText = await tokenResponse.text();
        let token = {};
        try { token = tokenText ? JSON.parse(tokenText) : {}; } catch {}
        if (!tokenResponse.ok || !token.access_token) throw new Error("O Discord não autorizou o login. Confira a Redirect URI da aplicação.");

        const userResponse = await fetch("https://discord.com/api/users/@me", {
            headers: { Authorization: `Bearer ${token.access_token}` },
            signal: AbortSignal.timeout(12000)
        });
        const user = await userResponse.json();
        if (!userResponse.ok || !/^\d{17,20}$/.test(String(user.id || ""))) throw new Error("Não foi possível ler a conta Discord.");

        await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
        req.session.discordUser = {
            id: String(user.id),
            username: String(user.username || "Discord"),
            globalName: String(user.global_name || user.username || "Discord"),
            avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null
        };
        await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
        await pool.query(`
            INSERT INTO eb_accounts (discord_id, discord_username)
            VALUES ($1, $2)
            ON CONFLICT (discord_id) DO UPDATE SET discord_username = EXCLUDED.discord_username, updated_at = NOW()
        `, [String(user.id), String(user.username || "Discord")]);
        return res.redirect("/");
    } catch (error) {
        console.error("[OAUTH DISCORD]", error.message);
        return res.redirect("/?erro=oauth");
    }
});

app.post("/auth/logout", validarOrigem, (req, res) => {
    req.session.destroy(error => {
        if (error) return res.status(500).json({ error: "Não foi possível sair da conta." });
        res.clearCookie("eb.verificacao.sid");
        res.json({ ok: true });
    });
});

app.get("/api/me", async (req, res) => {
    if (!req.session.discordUser) return res.json({ loggedIn: false, helpChannelId: CHANNEL_HELP_ID });
    try {
        const account = await obterConta(req.session.discordUser.id);
        res.json({
            loggedIn: true,
            user: req.session.discordUser,
            account: account ? {
                linked: account.linked,
                robloxUsername: account.roblox_username,
                inGroup: account.in_group,
                rankName: account.rank_name,
                rankNumber: account.rank_number,
                lastSyncedAt: account.last_synced_at,
                hasPendingCode: Boolean(account.verification_code && account.code_expires_at && new Date(account.code_expires_at).getTime() > Date.now())
            } : null,
            helpChannelId: CHANNEL_HELP_ID
        });
    } catch (error) {
        console.error("[ME]", error);
        res.status(500).json({ error: "Não foi possível carregar seu cadastro." });
    }
});

app.post("/api/register/start", validarOrigem, exigirLogin, async (req, res) => {
    try {
        const discordUser = req.session.discordUser;
        const code = `EB-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        await pool.query(`
            INSERT INTO eb_accounts (discord_id, discord_username, verification_code, code_expires_at, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (discord_id) DO UPDATE SET
                discord_username = EXCLUDED.discord_username,
                verification_code = EXCLUDED.verification_code,
                code_expires_at = EXCLUDED.code_expires_at,
                updated_at = NOW()
        `, [discordUser.id, discordUser.username, code, expiresAt]);
        res.json({
            ok: true,
            code,
            expiresAt: expiresAt.toISOString(),
            instruction: "Copie o código para a descrição pública (bio) do seu perfil Roblox, salve e depois informe seu nome de usuário Roblox aqui."
        });
    } catch (error) {
        console.error("[REGISTER START]", error);
        res.status(500).json({ error: "Não foi possível gerar o código de cadastro." });
    }
});

app.post("/api/register/confirm", validarOrigem, exigirLogin, async (req, res) => {
    const username = String(req.body.username || "").trim();
    if (!username || username.length > 32 || /[\r\n]/.test(username)) {
        return res.status(400).json({ error: "Informe um nome de usuário Roblox válido." });
    }
    try {
        const discordId = req.session.discordUser.id;
        const account = await obterConta(discordId);
        if (!account?.verification_code || !account.code_expires_at) {
            return res.status(400).json({ error: "Gere primeiro um código de cadastro." });
        }
        if (new Date(account.code_expires_at).getTime() < Date.now()) {
            return res.status(400).json({ error: "Seu código expirou. Gere um novo código e tente novamente." });
        }

        const robloxUser = await buscarUsuarioRobloxPorNome(username);
        if (!robloxUser) return res.status(404).json({ error: "Esse nome de usuário Roblox não foi encontrado. Confira a escrita e tente novamente." });
        const profile = await buscarPerfilRoblox(robloxUser.id);
        const description = String(profile.description || "");
        if (!description.toUpperCase().includes(String(account.verification_code).toUpperCase())) {
            return res.status(400).json({ error: "Não encontrei seu código na bio pública desse perfil. Salve a descrição no Roblox, aguarde um pouco e tente novamente." });
        }

        const listaGruposRoblox = await buscarGruposRoblox(robloxUser.id);
        const group = buscarPatenteEB(listaGruposRoblox);
        await pool.query(`
            UPDATE eb_accounts SET
                discord_username = $2,
                roblox_user_id = $3,
                roblox_username = $4,
                verification_code = NULL,
                code_expires_at = NULL,
                linked = TRUE,
                in_group = $5,
                rank_name = $6,
                rank_number = $7,
                updated_at = NOW()
            WHERE discord_id = $1
        `, [discordId, req.session.discordUser.username, robloxUser.id, robloxUser.name, group.inGroup, group.rankName, group.rankNumber]);

        res.json({
            ok: true,
            robloxUsername: robloxUser.name,
            inGroup: group.inGroup,
            rankName: group.rankName,
            rankNumber: group.rankNumber,
            message: group.inGroup
                ? `Conta vinculada! Patente encontrada no grupo EB: ${group.rankName}. Clique em Verificar para aplicar os cargos no Discord.`
                : "Conta vinculada! Não encontrei essa conta no grupo EB. Ao clicar em Verificar, o bot aplicará o cargo de verificado e o apelido [CIVIL]."
        });
    } catch (error) {
        console.error("[REGISTER CONFIRM]", error);
        if (error.status === 429) return res.status(429).json({ error: "O Roblox limitou as consultas temporariamente. Aguarde e tente novamente." });
        res.status(error.status === 404 ? 404 : 502).json({ error: error.message || "Não foi possível verificar a conta no Roblox. Tente novamente mais tarde." });
    }
});

app.post("/api/bot/verify", async (req, res) => {
    // Endpoint privado usado pelo botão do bot. Só aceita chamadas com o segredo compartilhado.
    const providedSecret = String(req.get("x-verification-secret") || "");
    if (!VERIFICATION_WEBHOOK_SECRET || providedSecret.length !== VERIFICATION_WEBHOOK_SECRET.length ||
        !crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(VERIFICATION_WEBHOOK_SECRET))) {
        return res.status(401).json({ sucesso: false, erro: "Não autorizado." });
    }

    const discordId = String(req.body.discordId || "");
    if (!/^\d{17,20}$/.test(discordId)) {
        return res.status(400).json({ sucesso: false, erro: "ID Discord inválido." });
    }

    try {
        const account = await obterConta(discordId);
        if (!account || !account.linked || !account.roblox_user_id) {
            return res.status(400).json({
                sucesso: false,
                erro: "Sua conta Roblox ainda não está cadastrada. Clique em Cadastrar sua conta, confirme a bio e tente novamente."
            });
        }

        const profile = await buscarPerfilRoblox(String(account.roblox_user_id));
        const robloxUsername = String(profile.name || account.roblox_username || "").trim();
        if (!robloxUsername) return res.status(502).json({ sucesso: false, erro: "Não consegui ler seu perfil Roblox." });
        const listaGruposRoblox = await buscarGruposRoblox(String(account.roblox_user_id));
        const group = buscarPatenteEB(listaGruposRoblox);
        const divisions = await buscarDivisoesRoblox(listaGruposRoblox, group);
        const sync = await chamarBot({
            action: "sync",
            discordId,
            robloxUsername,
            inGroup: group.inGroup,
            rankName: group.rankName,
            rankNumber: group.rankNumber,
            groupId: ROBLOX_GROUP_ID,
            divisions
        });

        await pool.query(`
            UPDATE eb_accounts SET roblox_username = $2, in_group = $3, rank_name = $4,
                rank_number = $5, last_synced_at = NOW(), updated_at = NOW()
            WHERE discord_id = $1
        `, [discordId, robloxUsername, group.inGroup, group.rankName, group.rankNumber]);

        return res.json({
            sucesso: true,
            robloxUsername,
            inGroup: group.inGroup,
            rankName: group.rankName,
            nickname: sync.nickname,
            addedRoles: sync.addedRoles || [],
            divisions: divisions.map(d => ({ name: d.name, inGroup: d.inGroup, rankName: d.rankName, cargoTipo: d.cargoTipo })),
            divisionWarnings: [...new Set([...(sync.divisionWarnings || []), ...divisions.filter(d => d.aviso).map(d => `${d.name}: ${d.aviso}`)])],
            mensagem: sync.mensagem || "Verificação concluída."
        });
    } catch (error) {
        console.error("[BOT VERIFY]", error.message);
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
        return res.status(status).json({ sucesso: false, erro: error.message || "Não foi possível sincronizar sua conta." });
    }
});

app.post("/api/verify", validarOrigem, exigirLogin, async (req, res) => {
    try {
        const discordId = req.session.discordUser.id;
        const account = await obterConta(discordId);
        if (!account || !account.linked || !account.roblox_user_id) {
            return res.status(400).json({ error: "Você ainda não cadastrou a conta Roblox. Use primeiro Cadastrar sua conta." });
        }

        // Reconsulta o perfil e a patente toda vez para que a patente não fique desatualizada.
        const profile = await buscarPerfilRoblox(String(account.roblox_user_id));
        const robloxUsername = String(profile.name || account.roblox_username || "").trim();
        if (!robloxUsername) return res.status(502).json({ error: "Não consegui confirmar o nome da conta Roblox." });
        const listaGruposRoblox = await buscarGruposRoblox(String(account.roblox_user_id));
        const group = buscarPatenteEB(listaGruposRoblox);
        const divisions = await buscarDivisoesRoblox(listaGruposRoblox, group);

        const result = await chamarBot({
            action: "sync",
            discordId,
            robloxUsername,
            inGroup: group.inGroup,
            rankName: group.rankName,
            rankNumber: group.rankNumber,
            groupId: ROBLOX_GROUP_ID,
            divisions
        });

        await pool.query(`
            UPDATE eb_accounts SET roblox_username = $2, in_group = $3, rank_name = $4,
                rank_number = $5, last_synced_at = NOW(), updated_at = NOW()
            WHERE discord_id = $1
        `, [discordId, robloxUsername, group.inGroup, group.rankName, group.rankNumber]);

        res.json({
            ok: true,
            nickname: result.nickname,
            addedRoles: result.addedRoles || [],
            inGroup: group.inGroup,
            rankName: group.rankName,
            divisions: divisions.map(d => ({ name: d.name, inGroup: d.inGroup, rankName: d.rankName, cargoTipo: d.cargoTipo })),
            divisionWarnings: [...new Set([...(result.divisionWarnings || []), ...divisions.filter(d => d.aviso).map(d => `${d.name}: ${d.aviso}`)])],
            message: result.mensagem || (group.inGroup ? "Sua patente foi sincronizada." : "Seu acesso Civil foi aplicado.")
        });
    } catch (error) {
        console.error("[VERIFY]", error.message);
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
        res.status(status).json({ error: error.message || "Não foi possível concluir a verificação. Tente novamente." });
    }
});

// Arquivos estáticos mantidos na raiz do repositório (sem pasta public/).
// Usamos rotas explícitas para não expor server.js, .env.example ou package.json.
const cacheControl = process.env.NODE_ENV === "production" ? "public, max-age=3600" : "no-store";

app.get(/^\/cadastro(?:\/cadastro)+\/?$/i, (_req, res) => res.redirect(301, "/cadastro"));

app.get(["/", "/cadastro", "/verificar", "/como-se-verificar"], (_req, res) => {
    res.setHeader("Cache-Control", cacheControl);
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/style.css", (_req, res) => {
    res.setHeader("Cache-Control", cacheControl);
    res.type("text/css").sendFile(path.join(__dirname, "style.css"));
});

app.get("/app.js", (_req, res) => {
    res.setHeader("Cache-Control", cacheControl);
    res.type("application/javascript").sendFile(path.join(__dirname, "app.js"));
});

app.use((error, _req, res, _next) => {
    console.error("[HTTP]", error);
    if (res.headersSent) return;
    res.status(500).json({ error: "Erro interno do site." });
});

prepararBanco().then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`Site de verificação EB iniciado na porta ${PORT}.`));
}).catch(error => {
    console.error("Não foi possível iniciar o banco do site:", error);
    process.exit(1);
});
